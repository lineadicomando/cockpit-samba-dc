import type { PasswordPolicy } from "./types.ts";

type LengthAndComplexity = Pick<PasswordPolicy, "complexityRequired" | "minLength">;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
// Symbols safe for samba-tool command arguments (no quotes, backslash, backtick)
const SYMBOLS = "!@#$%^&*_-+=~|;:.,?";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

function randomIndex(max: number): number {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
}

function pickFrom(charset: string): string {
    return charset[randomIndex(charset.length)];
}

function shuffle(arr: string[]): string[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export function generatePassword(policy: LengthAndComplexity): string {
    const len = Math.max(policy.minLength, 8);

    if (!policy.complexityRequired) {
        return Array.from({ length: len }, () => pickFrom(ALL)).join("");
    }

    // Guarantee at least one char from each of the 4 Windows complexity categories
    const required = [pickFrom(UPPER), pickFrom(LOWER), pickFrom(DIGITS), pickFrom(SYMBOLS)];
    const extra = Array.from({ length: len - 4 }, () => pickFrom(ALL));
    return shuffle([...required, ...extra]).join("");
}

export type PasswordViolation = "minLength" | "complexity";

// Windows/Samba complexity rule: at least 3 of the 4 character categories
const CATEGORY_PATTERNS = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/];

export function checkPasswordAgainstPolicy(policy: LengthAndComplexity, password: string): PasswordViolation | null {
    if (password.length < policy.minLength) return "minLength";
    if (policy.complexityRequired) {
        const matched = CATEGORY_PATTERNS.filter(re => re.test(password)).length;
        if (matched < 3) return "complexity";
    }
    return null;
}
