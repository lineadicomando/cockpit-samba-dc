import React from "react";
import { useTranslation } from "react-i18next";
import { DatePicker, FormGroup, Radio, yyyyMMddFormat } from "@patternfly/react-core";
import { expiryInstantFromDay, dayFromExpiryInstant, validateExpiryDay, expiryDateViolationMessage } from "../lib/validators.ts";

// What the field holds: never, or the last day the account can be used
// ("YYYY-MM-DD", the date picker's format).
export interface ExpiryValue {
    never: boolean;
    day: string;
}

export function expiryValueOf(accountExpires: number | null): ExpiryValue {
    return accountExpires === null
        ? { never: true, day: "" }
        : { never: false, day: dayFromExpiryInstant(accountExpires) };
}

// The exact instant, with the time: an expiry set elsewhere (samba-tool,
// Windows tools) need not fall at midnight.
export function formatExpiry(unixMs: number): string {
    return new Date(unixMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// The instant to write, null for "never"; undefined when the day is not valid.
export function expiryFromValue(value: ExpiryValue): Date | null | undefined {
    if (value.never) return null;
    return expiryInstantFromDay(value.day) ?? undefined;
}

export function expiryValueError(t: (key: string) => string, value: ExpiryValue): string | null {
    if (value.never) return null;
    const violation = validateExpiryDay(value.day);
    return violation ? expiryDateViolationMessage(t, violation) : null;
}

interface Props {
    id: string;
    value: ExpiryValue;
    onChange: (value: ExpiryValue) => void;
    isDisabled?: boolean;
    // Popover container: the body inside a modal, so the calendar is not cut off
    appendTo?: "inline" | (() => HTMLElement);
}

export function AccountExpiryField({ id, value, onChange, isDisabled, appendTo = "inline" }: Props) {
    const { t } = useTranslation();
    return (
        <FormGroup label={t("Account expires")} fieldId={`${id}-never`} role="radiogroup" isStack>
            <Radio id={`${id}-never`} name={id} label={t("Never")}
                isChecked={value.never} isDisabled={isDisabled}
                onChange={() => onChange({ ...value, never: true })} />
            <Radio id={`${id}-on`} name={id} label={t("At the end of")}
                isChecked={!value.never} isDisabled={isDisabled}
                onChange={() => onChange({ ...value, never: false })}
                body={
                    <DatePicker
                        value={value.day}
                        onChange={(_e, day) => onChange({ never: false, day })}
                        isDisabled={isDisabled || value.never}
                        appendTo={appendTo}
                        aria-label={t("Last day the account can be used")}
                        buttonAriaLabel={t("Choose a date")}
                        invalidFormatText={t("Enter a date as YYYY-MM-DD.")}
                        validators={[date => (expiryInstantFromDay(yyyyMMddFormat(date)) ? "" : t("Enter a date as YYYY-MM-DD."))]}
                    />
                } />
        </FormGroup>
    );
}

