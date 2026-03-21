import { unzipSync, strFromU8, inflateSync } from "fflate";

export type ImageMeta = {
    format: "png" | "jpeg" | "webp" | "unknown";
    fields: Record<string, unknown>;
    raw: Record<string, string>;
};

export async function parseImageMeta(buf: ArrayBuffer, ext: string): Promise<ImageMeta> {
    const u8 = new Uint8Array(buf);
    const lower = (ext || "").toLowerCase();
    const detected = detectFormatByHeader(u8);
    const fmt = detected !== "unknown" ? detected : (lower === "jpg" ? "jpeg" : (lower as any));
    if (fmt === "png") return parsePng(u8);
    if (fmt === "jpeg") return parseJpeg(u8);
    if (fmt === "webp") return parseWebp(u8);
    return { format: "unknown", fields: {}, raw: {} };
}

function detectFormatByHeader(u8: Uint8Array): "png" | "jpeg" | "webp" | "unknown" {
    if (u8.length >= 8) {
        const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
        let isPng = true;
        for (let i = 0; i < 8; i++) {
            if (u8[i] !== pngSig[i]) {
                isPng = false;
                break;
            }
        }
        if (isPng) return "png";
    }
    if (u8.length >= 12) {
        if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
            u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
            return "webp";
        }
    }
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8) return "jpeg";
    return "unknown";
}

function parsePng(u8: Uint8Array): ImageMeta {
    const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (u8[i] !== pngSig[i]) return { format: "png", fields: {}, raw: {} };
    }

    let off = 8;
    const raw: Record<string, string> = {};

    while (off + 8 <= u8.length) {
        const len = readU32(u8, off);
        off += 4;
        const type = strFromU8(u8.subarray(off, off + 4));
        off += 4;
        const data = u8.subarray(off, off + len);
        off += len;
        off += 4;

        if (type === "tEXt") {
            const { key, text } = parseText(data);
            if (key) raw[key] = text;
        } else if (type === "iTXt") {
            const { key, text } = parseInternationalText(data);
            if (key) raw[key] = text;
        } else if (type === "zTXt") {
            const { key, text } = parseCompressedText(data);
            if (key) raw[key] = text;
        }

        if (type === "IEND") break;
    }

    return { format: "png", fields: normalizeKnownFields(raw), raw };
}

function parseJpeg(u8: Uint8Array): ImageMeta {
    const raw: Record<string, string> = {};

    if (u8.length < 2 || u8[0] !== 0xff || u8[1] !== 0xd8) {
        return { format: "jpeg", fields: {}, raw };
    }

    let off = 2;
    let exifBytes: Uint8Array | null = null;
    let jpegComment: string | null = null;
    const XMP_STD = strToU8("http://ns.adobe.com/xap/1.0\x00");
    const XMP_EXT = strToU8("http://ns.adobe.com/xmp/extension/\x00");
    const xmpMain: string[] = [];
    const xmpExt: Record<string, { total: number; chunks: Record<number, Uint8Array>; }> = {};

    while (off + 4 <= u8.length) {
        if (u8[off] !== 0xff) {
            off++;
            continue;
        }

        while (off < u8.length && u8[off] === 0xff) off++;
        if (off >= u8.length) break;

        const marker = u8[off++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker >= 0xd0 && marker <= 0xd7) continue;
        if (off + 2 > u8.length) break;

        const segLen = ((u8[off] << 8) | u8[off + 1]) >>> 0;
        off += 2;
        if (segLen < 2 || off + segLen - 2 > u8.length) break;

        const seg = u8.subarray(off, off + segLen - 2);
        off += segLen - 2;

        if (marker === 0xe1) {
            if (startsWith(seg, strToU8("Exif\x00\x00"))) {
                exifBytes = seg;
            } else if (startsWith(seg, XMP_STD)) {
                try {
                    xmpMain.push(strFromU8(seg.subarray(XMP_STD.length)));
                } catch {
                    // ignore
                }
            } else if (startsWith(seg, XMP_EXT)) {
                const rest = seg.subarray(XMP_EXT.length);
                if (rest.length >= 40) {
                    const guid = safeAscii(rest.subarray(0, 32));
                    const total = readU32BE(rest, 32);
                    const chunkOffset = readU32BE(rest, 36);
                    const payload = rest.subarray(40);
                    const entry = xmpExt[guid] ?? { total, chunks: {} };
                    entry.total = total;
                    entry.chunks[chunkOffset] = payload;
                    xmpExt[guid] = entry;
                }
            }
        } else if (marker === 0xfe) {
            const text = tryDecodeUTF8(seg);
            if (text) jpegComment = text;
        }
    }

    const exifTexts: string[] = [];
    if (exifBytes) {
        try {
            const multi = extractExifTextsFromBytes(exifBytes);
            if (multi.user) exifTexts.push(multi.user);
            if (multi.xp) exifTexts.push(multi.xp);
            if (multi.desc) exifTexts.push(multi.desc);
        } catch {
            // ignore
        }
    }

    let xmpXml: string | null = null;
    if (xmpMain.length || Object.keys(xmpExt).length) {
        let extXml = "";
        for (const guid of Object.keys(xmpExt)) {
            const info = xmpExt[guid];
            const offsets = Object.keys(info.chunks).map((key) => Number(key)).sort((a, b) => a - b);
            let totalLength = 0;
            for (const chunkOffset of offsets) {
                totalLength += info.chunks[chunkOffset].length;
            }
            const buf = new Uint8Array(totalLength);
            let p = 0;
            for (const chunkOffset of offsets) {
                buf.set(info.chunks[chunkOffset], p);
                p += info.chunks[chunkOffset].length;
            }
            const total = Math.min(info.total, buf.length);
            try {
                extXml += strFromU8(buf.subarray(0, total));
            } catch {
                // ignore
            }
        }
        xmpXml = xmpMain.join("") + extXml;
    }

    const tryTexts: string[] = [];
    tryTexts.push(...exifTexts);
    if (xmpXml) {
        tryTexts.push(...extractFromXmpAttributes(xmpXml));
        tryTexts.push(xmpXml);
    }
    if (jpegComment) {
        tryTexts.push(jpegComment);
    }

    const selected = selectBestParametersFromTexts(tryTexts);
    if (selected) raw.parameters = selected;
    if (!raw.parameters) {
        const recovered = recoverParameters(u8, null);
        if (recovered) raw.parameters = recovered;
    } else if (looksGarbled(raw.parameters)) {
        const recovered = recoverParameters(u8, raw.parameters);
        if (recovered) raw.parameters = recovered;
    }

    if (exifTexts.length) raw.EXIF = exifTexts.join("\n");
    if (xmpXml) raw.XMP = xmpXml;
    if (jpegComment) raw.Comment = jpegComment;

    return { format: "jpeg", fields: normalizeKnownFields(raw), raw };
}

function parseWebp(u8: Uint8Array): ImageMeta {
    const raw: Record<string, string> = {};
    if (u8.length < 12 || u8[0] !== 0x52 || u8[1] !== 0x49 || u8[2] !== 0x46 || u8[3] !== 0x46 ||
        u8[8] !== 0x57 || u8[9] !== 0x45 || u8[10] !== 0x42 || u8[11] !== 0x50) {
        return { format: "webp", fields: {}, raw };
    }

    const readU32LE = (offset: number) => (u8[offset] | (u8[offset + 1] << 8) | (u8[offset + 2] << 16) | (u8[offset + 3] << 24)) >>> 0;
    let off = 12;
    let exifChunk: Uint8Array | null = null;
    let xmpXml: string | null = null;

    while (off + 8 <= u8.length) {
        const tag = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
        const size = readU32LE(off + 4);
        off += 8;
        if (off + size > u8.length) break;

        const data = u8.subarray(off, off + size);
        if (tag === "EXIF") {
            exifChunk = data;
        } else if (tag === "XMP ") {
            xmpXml = decodeXmpChunk(data);
        }
        off += size + (size & 1);
    }

    const exifTexts: string[] = [];
    if (exifChunk && exifChunk.length >= 8) {
        let payload = exifChunk;
        const header = strToU8("Exif\x00\x00");
        if (!startsWith(payload, header)) {
            const buf = new Uint8Array(header.length + payload.length);
            buf.set(header, 0);
            buf.set(payload, header.length);
            payload = buf;
        }
        try {
            const multi = extractExifTextsFromBytes(payload);
            if (multi.user) exifTexts.push(multi.user);
            if (multi.xp) exifTexts.push(multi.xp);
            if (multi.desc) exifTexts.push(multi.desc);
        } catch {
            // ignore
        }
    }

    const tryTexts: string[] = [];
    tryTexts.push(...exifTexts);
    if (xmpXml) {
        tryTexts.push(...extractFromXmpAttributes(xmpXml));
        tryTexts.push(xmpXml);
    }

    const selected = selectBestParametersFromTexts(tryTexts);
    if (selected) raw.parameters = selected;
    if (!raw.parameters) {
        const recovered = recoverParameters(u8, null);
        if (recovered) raw.parameters = recovered;
    }

    if (exifTexts.length) raw.EXIF = exifTexts.join("\n");
    if (xmpXml) raw.XMP = xmpXml;

    return { format: "webp", fields: normalizeKnownFields(raw), raw };
}

function readU32(u8: Uint8Array, offset: number): number {
    return (u8[offset] << 24 | u8[offset + 1] << 16 | u8[offset + 2] << 8 | u8[offset + 3]) >>> 0;
}

function parseText(data: Uint8Array): { key: string; text: string; } {
    const zero = data.indexOf(0);
    if (zero < 0) return { key: "", text: "" };
    return {
        key: latin1FromU8(data.subarray(0, zero)),
        text: latin1FromU8(data.subarray(zero + 1))
    };
}

function parseCompressedText(data: Uint8Array): { key: string; text: string; } {
    const zero = data.indexOf(0);
    if (zero < 0) return { key: "", text: "" };
    const key = latin1FromU8(data.subarray(0, zero));
    if (data[zero + 1] !== 0) return { key, text: "" };
    try {
        return { key, text: latin1FromU8(inflateSync(data.subarray(zero + 2))) };
    } catch {
        return { key, text: "" };
    }
}

function parseInternationalText(data: Uint8Array): { key: string; text: string; } {
    let p = 0;
    const readz = (): Uint8Array => {
        const z = data.indexOf(0, p);
        const out = data.subarray(p, z);
        p = z + 1;
        return out;
    };
    const key = strFromU8(readz());
    const compressed = data[p++];
    p++;
    readz();
    readz();
    const rest = data.subarray(p);
    try {
        return { key, text: compressed ? strFromU8(inflateSync(rest)) : strFromU8(rest) };
    } catch {
        return { key, text: "" };
    }
}

function latin1FromU8(u8: Uint8Array): string {
    let out = "";
    for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
    return out;
}

function normalizeKnownFields(raw: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    if (raw.parameters) {
        const text = raw.parameters;
        out.parameters_raw = text;
        const lines = text.split(/\r?\n/);
        if (lines.length > 0) out.prompt = lines[0];
        for (const line of lines.slice(1)) {
            const match = line.match(/^([^:]+):\s*(.*)$/);
            if (match) {
                out[match[1].trim()] = match[2].trim();
            }
        }
    }

    for (const key of ["prompt", "negative_prompt", "Prompt", "Negative prompt"]) {
        if (raw[key]) out[key.replace(/\s+/g, "_")] = raw[key];
    }

    for (const [key, value] of Object.entries(raw)) {
        const text = value.trim();
        if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
            try {
                out[`${key}_json`] = JSON.parse(text);
            } catch {
                // ignore
            }
        }
    }

    try {
        const comfy = extractComfy(out);
        if (comfy) Object.assign(out, comfy);
    } catch {
        // ignore
    }

    return out;
}

const NEGATIVE_PROMPT_RE = /(^|[\r\n])[\t ]*Negative prompt:/i;
const SETTINGS_STEPS_RE = /^[\t ]*Steps:[^\n]*/mi;
const SETTINGS_ANY_RE = /^[\t ]*(Sampler:|CFG scale:|Seed:|Size:|Model:|Schedule type:|Denoising strength:|Hires steps:)[^\n]*/mi;
const HAS_STEPS_RE = /(^|[\r\n])[\t ]*Steps:/i;
const HAS_SAMPLER_RE = /(^|[\r\n])[\t ]*Sampler:/i;
const HAS_CFG_RE = /(^|[\r\n])[\t ]*CFG scale:/i;
const HAS_SEED_RE = /(^|[\r\n])[\t ]*Seed:/i;
const HAS_SIZE_RE = /(^|[\r\n])[\t ]*Size:/i;

function extractComfy(parsed: Record<string, unknown>): Record<string, unknown> | null {
    const candidates: any[] = [];
    const pushIfGraph = (graph: any) => {
        if (!graph || typeof graph !== "object") return;
        const values = Object.values(graph as Record<string, unknown>);
        if (values.some((node: any) => node && typeof node === "object" && typeof node.class_type === "string")) {
            candidates.push(graph);
        }
    };

    if (parsed.prompt_json) pushIfGraph(parsed.prompt_json);
    if (parsed.workflow_json) {
        const workflow = parsed.workflow_json as any;
        if (workflow && typeof workflow === "object" && Array.isArray(workflow.nodes)) {
            const map: Record<string, unknown> = {};
            for (const node of workflow.nodes) {
                if (node && node.id !== undefined) map[String(node.id)] = node;
            }
            pushIfGraph(map);
        }
    }
    for (const [key, value] of Object.entries(parsed)) {
        if (!key.endsWith("_json")) continue;
        const object = value as any;
        if (object && typeof object === "object") {
            if (object.prompt) pushIfGraph(object.prompt);
            if (object.workflow) pushIfGraph(object.workflow);
        }
    }

    for (const graph of candidates) {
        const extracted = extractFromComfyPromptGraph(graph);
        if (extracted) return extracted;
    }

    return null;
}

function extractFromComfyPromptGraph(graph: Record<string, any>): Record<string, unknown> | null {
    const ids = Object.keys(graph);
    if (ids.length === 0) return null;
    const findNode = (predicate: (node: any) => boolean) => ids.map((id) => graph[id]).find(predicate);
    const samplerNode = findNode((node) => typeof node?.class_type === "string" && node.class_type.startsWith("KSampler"));
    if (!samplerNode) return null;

    const out: Record<string, unknown> = { generator: "ComfyUI" };
    const inputs = samplerNode.inputs || {};
    if (inputs.seed !== undefined) out.seed = inputs.seed;
    if (inputs.steps !== undefined) out.steps = inputs.steps;
    if (inputs.cfg !== undefined) out.cfg_scale = inputs.cfg;
    if (inputs.sampler_name !== undefined) out.sampler = inputs.sampler_name;
    if (inputs.scheduler !== undefined) out.scheduler = inputs.scheduler;
    if (inputs.denoise !== undefined) out.denoise = inputs.denoise;

    const resolveText = (connection: any): string | undefined => {
        if (!connection) return undefined;
        const sourceId = Array.isArray(connection) ? connection[0] : connection;
        const node = graph[String(sourceId)];
        if (!node) return undefined;
        const nodeInputs = node.inputs || {};
        if (typeof nodeInputs.text === "string") return nodeInputs.text;
        const parts: string[] = [];
        if (typeof nodeInputs.text_g === "string") parts.push(nodeInputs.text_g);
        if (typeof nodeInputs.text_l === "string") parts.push(nodeInputs.text_l);
        return parts.length > 0 ? parts.join(" ") : undefined;
    };

    const positive = resolveText(inputs.positive);
    const negative = resolveText(inputs.negative);
    if (positive) out.prompt = positive;
    if (negative) out.negative_prompt = negative;

    return out;
}

function decodeXmpChunk(data: Uint8Array): string {
    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
        try { return strFromU8(data.subarray(3)); } catch { return ""; }
    }
    if (data.length >= 2) {
        if (data[0] === 0xfe && data[1] === 0xff) {
            try { return new TextDecoder("utf-16be").decode(data.subarray(2)); } catch { return ""; }
        }
        if (data[0] === 0xff && data[1] === 0xfe) {
            try { return new TextDecoder("utf-16le").decode(data.subarray(2)); } catch { return ""; }
        }
    }
    return decodeBest(data) ?? "";
}

function strToU8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function startsWith(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length < b.length) return false;
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function readU32BE(data: Uint8Array, offset: number): number {
    return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function tryDecodeUTF8(data: Uint8Array): string | null {
    return decodeBest(data);
}

function decodeShiftJIS(data: Uint8Array): string | null {
    try { return new TextDecoder("shift_jis" as any).decode(data); } catch { return null; }
}

function safeAscii(data: Uint8Array): string {
    let out = "";
    for (let i = 0; i < data.length; i++) {
        const char = data[i];
        out += char < 32 || char > 126 ? "?" : String.fromCharCode(char);
    }
    return out;
}

type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "utf-16" | "latin1" | "shift_jis";

function decodeBytes(data: Uint8Array, encoding: TextEncodingName): string | null {
    try {
        if (encoding === "latin1") {
            let out = "";
            for (let i = 0; i < data.length; i++) out += String.fromCharCode(data[i]);
            return out;
        }
        if (encoding === "shift_jis") {
            return new TextDecoder("shift_jis" as any).decode(data);
        }
        if (encoding === "utf-16") {
            try { return new TextDecoder("utf-16le").decode(data); } catch { return new TextDecoder("utf-16be").decode(data); }
        }
        return new TextDecoder(encoding as any).decode(data);
    } catch {
        return null;
    }
}

function decodeBest(data: Uint8Array, prefer?: TextEncodingName): string | null {
    const encodings: TextEncodingName[] = [];
    if (prefer) encodings.push(prefer);
    if (looksLikeShiftJis(data) && !encodings.includes("shift_jis")) encodings.unshift("shift_jis");
    for (const encoding of ["utf-8", "utf-16le", "utf-16be", "shift_jis", "latin1"] as TextEncodingName[]) {
        if (!encodings.includes(encoding)) encodings.push(encoding);
    }

    let best: { text: string; score: number; } | null = null;
    for (const encoding of encodings) {
        const text = decodeBytes(data, encoding);
        if (text == null) continue;
        const score = scoreDecodedString(text);
        if (!best || score > best.score) best = { text, score };
    }

    return best?.text ?? null;
}

function scoreDecodedString(text: string): number {
    if (!text) return -1;
    let score = 0;
    let replacement = 0;
    let cjk = 0;
    let kana = 0;
    let ascii = 0;
    let controls = 0;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 0xfffd) replacement++;
        if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk++;
        else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) kana++;
        else if (code >= 32 && code <= 126) ascii++;
        else if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls++;
    }

    score -= replacement * 100;
    score += cjk * 5 + kana * 4 + ascii * 0.3;
    score -= controls * 5;
    score += (countChar(text, ",") + countChar(text, ":") + countChar(text, ";")) * 0.5;
    return score;
}

function countChar(text: string, char: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === char) count++;
    return count;
}

function countByte(data: Uint8Array, value: number): number {
    let count = 0;
    for (let i = 0; i < data.length; i++) if (data[i] === value) count++;
    return count;
}

function looksLikeShiftJis(data: Uint8Array): boolean {
    let pairs = 0;
    let i = 0;
    while (i < data.length) {
        const x = data[i];
        if ((x >= 0x81 && x <= 0x9f) || (x >= 0xe0 && x <= 0xfc)) {
            const y = data[i + 1];
            if (y !== undefined && ((y >= 0x40 && y <= 0x7e) || (y >= 0x80 && y <= 0xfc))) {
                pairs++;
                i += 2;
                continue;
            }
        }
        i++;
    }
    return pairs / Math.max(1, Math.floor(data.length / 2)) > 0.05;
}

function maybeFixUtf16EndianMisdecode(text: string | null): string | null {
    if (!text) return text;
    let zeroLow = 0;
    for (let i = 0; i < text.length; i++) {
        if ((text.charCodeAt(i) & 0xff) === 0) zeroLow++;
    }
    if (zeroLow / Math.max(1, text.length) <= 0.3) return text;
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes[i * 2] = (code >> 8) & 0xff;
        bytes[i * 2 + 1] = code & 0xff;
    }
    try {
        return new TextDecoder("utf-16le").decode(bytes);
    } catch {
        return text;
    }
}

function decodeExifUserComment(raw: Uint8Array | string | number[] | undefined | null): string | null {
    if (raw == null) return null;
    if (raw instanceof Uint8Array) {
        const prefix = raw.subarray(0, Math.min(8, raw.length));
        const hasMarker = startsWith(prefix, strToU8("ASCII")) || startsWith(prefix, strToU8("UNICODE")) || startsWith(prefix, strToU8("JIS"));
        const data = hasMarker ? raw.subarray(8) : raw;
        const candidates: string[] = [];
        const isUnicode = startsWith(prefix, strToU8("UNICODE"));
        const isJis = startsWith(prefix, strToU8("JIS"));
        if (isJis) {
            const sj = decodeBytes(data, "shift_jis");
            if (sj) candidates.push(sj);
        }
        if (isUnicode) {
            const le = decodeBytes(data, "utf-16le");
            const be = decodeBytes(data, "utf-16be");
            if (le) candidates.push(le);
            if (be) candidates.push(be);
        }
        const utf16Likely = (countByte(data, 0x00) / Math.max(1, data.length)) > 0.2;
        const tryEnc: TextEncodingName[] = utf16Likely ? ["utf-16le", "utf-16", "utf-8"] : ["utf-8", "utf-16le", "utf-16"];
        for (const encoding of tryEnc) {
            const value = decodeBytes(data, encoding);
            if (value) candidates.push(value);
        }
        if (!isUnicode) {
            const sj = decodeBytes(data, "shift_jis");
            if (sj) candidates.push(sj);
        }
        let best: { text: string; score: number; } | null = null;
        for (const candidate of candidates) {
            const text = candidate.replace(/\u0000+/g, "");
            if (!text) continue;
            const score = scoreSdTextCandidate(text) + 0.5 * scoreDecodedString(text);
            if (!best || score > best.score) best = { text, score };
        }
        if (best) return best.text;
        const latin1 = decodeBytes(data, "latin1");
        return latin1 ? latin1.replace(/\u0000/g, "") : null;
    }
    if (typeof raw === "string") {
        return raw.replace(/\u0000/g, "");
    }
    if (Array.isArray(raw)) {
        const text = decodeBytes(new Uint8Array(raw), "utf-16le");
        return text ? text.replace(/\u0000+$/g, "") : null;
    }
    return null;
}

function scoreSdTextCandidate(text: string): number {
    let score = 0;
    if (NEGATIVE_PROMPT_RE.test(text)) score += 5;
    if (HAS_STEPS_RE.test(text)) score += 4;
    if (HAS_SAMPLER_RE.test(text)) score += 2;
    if (HAS_CFG_RE.test(text)) score += 2;
    if (HAS_SEED_RE.test(text)) score += 2;
    if (HAS_SIZE_RE.test(text)) score += 2;
    return score;
}

function extractExifTextsFromBytes(exif: Uint8Array): { user?: string | null; xp?: string | null; desc?: string | null; } {
    if (!startsWith(exif, strToU8("Exif\x00\x00"))) return {};
    const base = 6;
    const endian = String.fromCharCode(exif[base], exif[base + 1]);
    const isLE = endian === "II";
    const u16 = (offset: number) => isLE ? (exif[offset] | (exif[offset + 1] << 8)) : ((exif[offset] << 8) | exif[offset + 1]);
    const u32 = (offset: number) => isLE
        ? (exif[offset] | (exif[offset + 1] << 8) | (exif[offset + 2] << 16) | (exif[offset + 3] << 24)) >>> 0
        : ((exif[offset] << 24) | (exif[offset + 1] << 16) | (exif[offset + 2] << 8) | exif[offset + 3]) >>> 0;
    if (u16(base + 2) !== 42) return {};

    const readIFD = (offset: number): Record<number, [number, number, Uint8Array]> => {
        const tags: Record<number, [number, number, Uint8Array]> = {};
        if (offset <= 0 || offset + 2 > exif.length) return tags;
        const count = u16(offset);
        for (let i = 0; i < count; i++) {
            const entry = offset + 2 + i * 12;
            if (entry + 12 > exif.length) break;
            const tag = u16(entry);
            const type = u16(entry + 2);
            const itemCount = u32(entry + 4);
            const rawValue = exif.subarray(entry + 8, entry + 12);
            const typeSize = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
            const total = typeSize * itemCount;
            let value = rawValue.subarray(0, total);
            if (total > 4) {
                const valueOffset = base + u32(entry + 8);
                if (valueOffset + total > exif.length) continue;
                value = exif.subarray(valueOffset, valueOffset + total);
            }
            tags[tag] = [type, itemCount, value];
        }
        return tags;
    };

    const ifd0 = base + u32(base + 4);
    const tags0 = readIFD(ifd0);

    let desc: string | null = null;
    if (tags0[0x010e]) {
        let value = tags0[0x010e][2];
        while (value.length && value[value.length - 1] === 0) value = value.subarray(0, value.length - 1);
        const utf16 = (value.length >= 2 && ((value[0] === 0xff && value[1] === 0xfe) || (value[0] === 0xfe && value[1] === 0xff))) ||
            (value.length && (countByte(value, 0x00) / value.length) > 0.2);
        if (utf16) {
            desc = decodeBytes(value, "utf-16");
        } else {
            const utf8 = tryDecodeUTF8(value);
            desc = utf8 && utf8.includes("\ufffd") ? (decodeShiftJIS(value) ?? utf8) : utf8;
        }
    }

    let user: string | null = null;
    if (tags0[0x8769]) {
        const ptr = tags0[0x8769][2];
        const subIfd = base + (isLE
            ? (ptr[0] | (ptr[1] << 8) | (ptr[2] << 16) | (ptr[3] << 24)) >>> 0
            : ((ptr[0] << 24) | (ptr[1] << 16) | (ptr[2] << 8) | ptr[3]) >>> 0);
        const exifTags = readIFD(subIfd);
        if (exifTags[0x9286]) {
            user = decodeExifUserComment(exifTags[0x9286][2]) ?? null;
        }
    }

    let xp: string | null = null;
    for (const tag of [0x9c9c, 0x9c9b]) {
        if (tags0[tag]) {
            const text = decodeBytes(tags0[tag][2], "utf-16le");
            if (text) {
                xp = text.replace(/\u0000+$/g, "");
                break;
            }
        }
    }

    return {
        user: typeof user === "string" ? maybeFixUtf16EndianMisdecode(user) : user,
        xp: typeof xp === "string" ? maybeFixUtf16EndianMisdecode(xp) : xp,
        desc: typeof desc === "string" ? maybeFixUtf16EndianMisdecode(desc) : desc
    };
}

function interpretSdText(text: string | null): string | null {
    if (!text) return null;
    const fixed = maybeFixUtf16EndianMisdecode(text) ?? text;
    const obj = tryParseJsonPayload(fixed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const metadata = (obj as any)["sd-metadata"] || (obj as any).sd_metadata || obj;
        const asText = forgeMetadataToParameters(metadata) || (obj as any).parameters;
        if (typeof asText === "string") return asText;
    }
    if (NEGATIVE_PROMPT_RE.test(fixed) || HAS_STEPS_RE.test(fixed)) return fixed;
    if ((fixed.match(/,/g) || []).length >= 2 || fixed.length > 80) return fixed;
    return null;
}

function tryParseJsonPayload(text: string): any | null {
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
            try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
        }
    }
    return null;
}

function forgeMetadataToParameters(metadata: any): string | null {
    if (!metadata || typeof metadata !== "object") return null;
    try {
        const prompt = metadata.prompt || metadata.Prompt || "";
        const negative = metadata.negativePrompt || metadata["Negative prompt"] || metadata.negative_prompt || "";
        const steps = metadata.steps ?? metadata.Steps;
        const sampler = metadata.sampler || metadata.Sampler;
        const cfg = metadata.cfgScale ?? metadata.cfg ?? metadata["CFG scale"];
        const seed = metadata.seed ?? metadata.Seed;
        const width = metadata.width ?? metadata.Width;
        const height = metadata.height ?? metadata.Height;
        const model = metadata.model ?? metadata.Model ?? (metadata.hashes && metadata.hashes.model);
        const lines = [String(prompt).trim(), negative ? `Negative prompt: ${negative}` : "Negative prompt:"];
        const tail: string[] = [];
        if (steps !== undefined) tail.push(`Steps: ${steps}`);
        if (sampler) tail.push(`Sampler: ${sampler}`);
        if (cfg !== undefined) tail.push(`CFG scale: ${cfg}`);
        if (seed !== undefined) tail.push(`Seed: ${seed}`);
        if (width && height) tail.push(`Size: ${width}x${height}`);
        if (model) tail.push(`Model: ${model}`);
        if (tail.length) lines.push(tail.join(", "));
        return lines.join("\n").trim();
    } catch {
        return null;
    }
}

function looksGarbled(text: string): boolean {
    if (!text) return false;
    if (text.includes("\ufffd") || text.includes("\u0000")) return true;
    let high = 0;
    let alpha = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) alpha++;
        if (code > 0x7e) high++;
    }
    return (high / Math.max(1, text.length)) > 0.5 && alpha < text.length * 0.1;
}

function scanFileForSdText(data: Uint8Array): string | null {
    const ascii = "Negative prompt:";
    const le = new Uint8Array(ascii.length * 2);
    const be = new Uint8Array(ascii.length * 2);
    for (let i = 0; i < ascii.length; i++) {
        const ch = ascii.charCodeAt(i);
        le[i * 2] = ch;
        le[i * 2 + 1] = 0;
        be[i * 2] = 0;
        be[i * 2 + 1] = ch;
    }
    const idxLE = indexOfBytes(data, le);
    const idxBE = indexOfBytes(data, be);
    if (idxLE >= 0) {
        try {
            return extractParametersBlock(new TextDecoder("utf-16le").decode(data.subarray(Math.max(0, idxLE - 4096), Math.min(data.length, idxLE + 8192))));
        } catch {
            // ignore
        }
    }
    if (idxBE >= 0) {
        try {
            return extractParametersBlock(new TextDecoder("utf-16be").decode(data.subarray(Math.max(0, idxBE - 4096), Math.min(data.length, idxBE + 8192))));
        } catch {
            // ignore
        }
    }
    return null;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function extractParametersBlock(text: string): string | null {
    const idx = text.indexOf("Negative prompt:");
    if (idx === -1) return null;
    const after = text.indexOf("\n", idx);
    const tailStart = after > 0 ? after + 1 : text.length;
    const picked = pickSettingsLineWithIndex(text.slice(tailStart));
    if (picked) {
        return text.slice(0, tailStart + picked.end);
    }
    return text;
}

function pickSettingsLineWithIndex(text: string): { line: string; index: number; end: number; } | null {
    let match = SETTINGS_STEPS_RE.exec(text);
    if (!match) match = SETTINGS_ANY_RE.exec(text);
    if (!match) return null;
    return {
        line: match[0].trim(),
        index: match.index,
        end: match.index + match[0].length
    };
}

function extractA1111BlockFromText(text: string): string | null {
    const fixed = maybeFixUtf16EndianMisdecode(text) ?? text;
    const idx = fixed.indexOf("Negative prompt:");
    if (idx < 0) return null;
    const after = fixed.indexOf("\n", idx);
    const tailStart = after > 0 ? after + 1 : fixed.length;
    const picked = pickSettingsLineWithIndex(fixed.slice(tailStart));
    return picked ? fixed.slice(0, tailStart + picked.end) : fixed;
}

function scoreA1111Block(text: string): number {
    let score = 0;
    const lower = text.toLowerCase();
    if (lower.includes("negative prompt:")) score += 5;
    if (lower.includes("steps:")) score += 4;
    if (lower.includes("sampler:")) score += 2;
    if (lower.includes("cfg scale:")) score += 2;
    if (lower.includes("seed:")) score += 2;
    if (lower.includes("size:")) score += 2;
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    if (lines === 3) score += 3;
    else if (lines === 2) score += 2;
    else if (lines >= 4) score += 1;
    if (text.length > 50 && text.length < 4000) score += 1;
    return score;
}

function extractFromXmpAttributes(xml: string): string[] {
    const out: string[] = [];
    for (const key of ["sd-metadata", "sd_metadata", "parameters", "Parameters"]) {
        const re = new RegExp(`${key}\\s*=\\s*([\"'])(.*?)\\1`, "is");
        const match = xml.match(re);
        if (match?.[2]) out.push(htmlUnescape(match[2]));
    }
    return out;
}

function htmlUnescape(text: string): string {
    return text
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function scanWholeFileForMeta(data: Uint8Array): string | null {
    let text = "";
    try {
        text = new TextDecoder("utf-8").decode(data);
    } catch {
        return null;
    }
    for (const key of ["sd-metadata", "sd_metadata", "\"prompt\"", "\"Negative prompt\"", "Negative prompt:"]) {
        const idx = text.indexOf(key);
        if (idx === -1) continue;
        const startBrace = text.lastIndexOf("{", idx);
        const endBrace = text.indexOf("}", idx);
        if (startBrace !== -1 && endBrace !== -1) {
            let depth = 0;
            let end = -1;
            for (let i = startBrace; i < text.length; i++) {
                if (text[i] === "{") depth++;
                else if (text[i] === "}") {
                    depth--;
                    if (depth === 0) {
                        end = i + 1;
                        break;
                    }
                }
            }
            if (end !== -1) {
                try {
                    const obj = JSON.parse(text.slice(startBrace, end));
                    const metadata = (obj as any)["sd-metadata"] || (obj as any).sd_metadata || obj;
                    const converted = forgeMetadataToParameters(metadata) || (obj as any).parameters;
                    if (converted) return converted;
                } catch {
                    // ignore
                }
            }
        }
        if (NEGATIVE_PROMPT_RE.test(text)) {
            const negativeIdx = text.search(NEGATIVE_PROMPT_RE);
            const start = Math.max(0, negativeIdx - 1200);
            const end = text.indexOf("\n\n", negativeIdx);
            return text.slice(start, end !== -1 ? end : negativeIdx + 2000).trim();
        }
    }
    return null;
}

function scanWholeFileForUtf16A1111(data: Uint8Array): string | null {
    const variants: string[] = [];
    try { variants.push(new TextDecoder("utf-16le").decode(data)); } catch { /* ignore */ }
    try { variants.push(new TextDecoder("utf-16be").decode(data)); } catch { /* ignore */ }
    let best: { text: string; score: number; } | null = null;
    for (const variant of variants) {
        const block = extractA1111BlockFromText(variant) || extractBySettingsLineOnly(variant);
        if (!block) continue;
        const score = scoreA1111Block(block) - (looksGarbled(block) ? 5 : 0);
        if (!best || score > best.score) best = { text: block, score };
    }
    return best?.text ?? null;
}

function scanWholeFileForSjisA1111(data: Uint8Array): string | null {
    try {
        const text = new TextDecoder("shift_jis" as any).decode(data);
        return extractA1111BlockFromText(text) || extractBySettingsLineOnly(text);
    } catch {
        return null;
    }
}

function selectBestParametersFromTexts(texts: string[]): string | null {
    let best: { text: string; score: number; } | null = null;
    for (const text of texts) {
        if (!text) continue;
        const primary = extractA1111BlockFromText(text);
        if (primary) {
            const score = scoreA1111Block(primary);
            if (!best || score > best.score) best = { text: primary, score };
            continue;
        }
        const interpreted = interpretSdText(text);
        if (interpreted) {
            const block = extractA1111BlockFromText(interpreted) || interpreted;
            const score = scoreA1111Block(block);
            if (!best || score > best.score) best = { text: block, score };
        }
    }
    return best?.text ?? null;
}

function recoverParameters(data: Uint8Array, existing: string | null): string | null {
    if (!existing) {
        return scanWholeFileForMeta(data) ?? scanFileForSdText(data) ?? scanWholeFileForUtf16A1111(data) ?? scanWholeFileForSjisA1111(data);
    }
    if (!looksGarbled(existing)) return null;
    return scanFileForSdText(data) ?? scanWholeFileForUtf16A1111(data) ?? scanWholeFileForSjisA1111(data);
}

function extractBySettingsLineOnly(text: string): string | null {
    const picked = pickSettingsLineWithIndex(text);
    return picked ? text.slice(0, picked.end) : null;
}
