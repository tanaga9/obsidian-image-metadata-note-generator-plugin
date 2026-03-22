export type ConvertedTag = {
    original: string;
    name: string;
    quotedTag: string;
    quotedTagUnderscore: string;
    obsidianTag: string;
};

const ATTENTION_RE = /\\\(|\\\)|\\\[|\\]|\\\\|\\|\(|\[|:\s*([+-]?(?:\.\d+|\d+(?:\.\d+)?))\s*\)|\)|]|[^\\()\[\]:]+|:/g;

export function parsePromptAttention(text: string): Array<[string, number]> {
    const result: Array<[string, number]> = [];
    const roundBrackets: number[] = [];
    const squareBrackets: number[] = [];
    const roundMultiplier = 1.1;
    const squareMultiplier = 1 / 1.1;

    const multiplyRange = (start: number, multiplier: number) => {
        for (let i = start; i < result.length; i++) {
            result[i][1] *= multiplier;
        }
    };

    let match: RegExpExecArray | null;
    ATTENTION_RE.lastIndex = 0;

    while ((match = ATTENTION_RE.exec(text)) !== null) {
        const token = match[0];
        const weight = match[1];

        if (token.startsWith("\\")) {
            result.push([token.slice(1), 1.0]);
        } else if (token === "(") {
            roundBrackets.push(result.length);
        } else if (token === "[") {
            squareBrackets.push(result.length);
        } else if (weight != null && roundBrackets.length > 0) {
            multiplyRange(roundBrackets.pop()!, Number(weight));
        } else if (token === ")" && roundBrackets.length > 0) {
            multiplyRange(roundBrackets.pop()!, roundMultiplier);
        } else if (token === "]" && squareBrackets.length > 0) {
            multiplyRange(squareBrackets.pop()!, squareMultiplier);
        } else {
            result.push([token, 1.0]);
        }
    }

    for (const pos of roundBrackets) {
        multiplyRange(pos, roundMultiplier);
    }

    for (const pos of squareBrackets) {
        multiplyRange(pos, squareMultiplier);
    }

    if (result.length === 0) {
        return [["", 1.0]];
    }

    const merged: Array<[string, number]> = [result[0]];

    for (let i = 1; i < result.length; i++) {
        const prev = merged[merged.length - 1];
        const current = result[i];
        if (prev[1] === current[1]) {
            prev[0] += current[0];
        } else {
            merged.push(current);
        }
    }

    return merged;
}

export function promptToTags(prompt: string): string[] {
    const parsed = parsePromptAttention(prompt);
    const tags = new Set<string>();

    for (const [text] of parsed) {
        for (const piece of text.split(/[,，\n]+/)) {
            const trimmed = piece.trim();
            if (trimmed) {
                tags.add(trimmed);
            }
        }
    }

    return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

export function splitPromptAndParameters(parameters: string): {
    prompt: string;
    negativePrompt: string;
    settingsLine: string;
} {
    const lines = parameters.split(/\r?\n/);
    const negativeIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith("negative prompt:"));
    const settingsIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith("steps:"));

    const promptEnd = negativeIndex >= 0 ? negativeIndex : (settingsIndex >= 0 ? settingsIndex : lines.length);
    const prompt = lines.slice(0, promptEnd).join("\n").trim();

    let negativePrompt = "";
    if (negativeIndex >= 0) {
        const negativeLine = lines[negativeIndex];
        negativePrompt = negativeLine.replace(/^\s*Negative prompt:\s*/i, "").trim();
    }

    const settingsLine = settingsIndex >= 0 ? lines[settingsIndex].trim() : "";
    return { prompt, negativePrompt, settingsLine };
}

export function extractModelNames(parameters: string): string[] {
    const matches = Array.from(parameters.matchAll(/(?:^|,\s*)Model:\s*([^,\n]+)/gmi));
    const models = new Set<string>();

    for (const match of matches) {
        const model = match[1]?.trim();
        if (model) {
            models.add(model);
        }
    }

    return Array.from(models);
}

export function transformColons(value: string): string {
    const chars: string[] = [];
    let colonCount = 0;

    for (const char of value) {
        if (char === ":") {
            colonCount += 1;
            if (colonCount === 1) {
                chars.push("/");
                continue;
            }
            break;
        }

        chars.push(char);
    }

    return chars.join("");
}

function splitRecursive(segments: string[], knownTags: Set<string>): string[] {
    const result: string[] = [];
    const keys = Array.from(knownTags).sort((a, b) => b.length - a.length);

    for (const segment of segments) {
        let matched = false;

        for (const key of keys) {
            const idx = segment.indexOf(key);
            if (idx === -1) {
                continue;
            }

            const before = segment.slice(0, idx);
            const match = segment.slice(idx, idx + key.length);
            const after = segment.slice(idx + key.length);

            if (before) {
                result.push(...splitRecursive([before], knownTags));
            }

            result.push(match);

            if (after) {
                result.push(...splitRecursive([after], knownTags));
            }

            matched = true;
            break;
        }

        if (!matched) {
            result.push(segment);
        }
    }

    return result;
}

export function splitTagByKnownNotes(tag: string, knownTags: Set<string>): string[] {
    if (knownTags.size === 0) {
        return [tag];
    }

    return splitRecursive([tag], knownTags);
}

export function convertTag(tag: string): ConvertedTag {
    const original = tag;
    const name = tag.trim().split("/").pop() ?? tag.trim();

    return {
        original,
        name,
        quotedTag: encodeURIComponent(name),
        quotedTagUnderscore: encodeURIComponent(name.replace(/ /g, "_")),
        obsidianTag: toObsidianTag(original)
    };
}

export function toObsidianTag(tag: string): string {
    const normalized = tag
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[\\/]+/g, "_")
        .replace(/[^\p{L}\p{N}_-]+/gu, "_")
        .replace(/_+/g, "_")
        .replace(/^[_-]+|[_-]+$/g, "");

    if (!normalized) {
        return "";
    }

    if (/^\d+$/.test(normalized)) {
        return `t_${normalized}`;
    }

    return normalized;
}
