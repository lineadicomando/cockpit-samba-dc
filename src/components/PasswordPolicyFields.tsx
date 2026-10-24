import React from "react";
import { useTranslation } from "react-i18next";
import {
    FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput, Checkbox, Switch,
} from "@patternfly/react-core";
import type { PasswordPolicy } from "../lib/types.ts";

// The fields of a password policy, the domain's or a PSO's, as the form
// holds them: numbers as typed, and a check box for "never" where the
// setting allows it.
interface NumberField {
    value: string;
    never: boolean;
}

export interface PolicyForm {
    complexity: boolean;
    minLength: NumberField;
    history: NumberField;
    minAge: NumberField;
    maxAge: NumberField;
    threshold: NumberField;
    duration: NumberField;
    resetAfter: NumberField;
}

function field(value: number | null): NumberField {
    return { value: value === null ? "" : String(value), never: value === null };
}

function parse(f: NumberField): number {
    return f.value.trim() === "" ? NaN : Number(f.value);
}

export function policyForm(p: PasswordPolicy): PolicyForm {
    return {
        complexity: p.complexityRequired,
        minLength: field(p.minLength),
        history: field(p.historyLength),
        minAge: field(p.minAgeDays),
        maxAge: field(p.maxAgeDays),
        threshold: field(p.lockoutThreshold),
        duration: field(p.lockoutDurationMinutes),
        resetAfter: field(p.lockoutWindowMinutes),
    };
}

// NaN where a number is missing or not one: the validator reports it
export function policyFromForm(f: PolicyForm): PasswordPolicy {
    return {
        complexityRequired: f.complexity,
        minLength: parse(f.minLength),
        historyLength: parse(f.history),
        minAgeDays: parse(f.minAge),
        maxAgeDays: f.maxAge.never ? null : parse(f.maxAge),
        lockoutThreshold: parse(f.threshold),
        lockoutDurationMinutes: f.duration.never ? null : parse(f.duration),
        lockoutWindowMinutes: f.resetAfter.never ? null : parse(f.resetAfter),
    };
}

interface Props {
    id: string;
    form: PolicyForm;
    onChange: (form: PolicyForm) => void;
    // A PSO allows longer passwords and histories
    pso?: boolean;
}

export function PasswordPolicyFields({ id, form, onChange, pso }: Props) {
    const { t } = useTranslation();
    type Key = Exclude<keyof PolicyForm, "complexity">;

    function set(key: Key, value: NumberField) {
        onChange({ ...form, [key]: value });
    }

    function numberInput(key: Key) {
        const f = form[key];
        return (
            <TextInput
                id={`${id}-${key}`}
                type="number"
                min={0}
                value={f.never ? "" : f.value}
                isDisabled={f.never}
                onChange={(_e, v) => set(key, { ...f, value: v })}
                style={{ maxWidth: "10rem" }}
            />
        );
    }

    function neverBox(key: Key, label: string) {
        const f = form[key];
        return (
            <Checkbox
                id={`${id}-${key}-never`}
                label={label}
                isChecked={f.never}
                onChange={(_e, checked) => set(key, { value: f.value, never: checked })}
            />
        );
    }

    function help(text: string) {
        return (
            <FormHelperText>
                <HelperText><HelperTextItem>{text}</HelperTextItem></HelperText>
            </FormHelperText>
        );
    }

    return (
        <>
            <FormGroup label={t("Complexity")} fieldId={`${id}-complexity`}>
                <Switch
                    id={`${id}-complexity`}
                    label={t("Passwords must be complex")}
                    isChecked={form.complexity}
                    onChange={(_e, checked) => onChange({ ...form, complexity: checked })}
                />
                {help(t("Three of: uppercase, lowercase, digits, symbols; not the account name."))}
            </FormGroup>
            <FormGroup label={t("Minimum length")} fieldId={`${id}-minLength`}>
                {numberInput("minLength")}
                {help(pso ? t("Characters, from 0 to 255.") : t("Characters, from 0 to 14."))}
            </FormGroup>
            <FormGroup label={t("Password history")} fieldId={`${id}-history`}>
                {numberInput("history")}
                {help(pso
                    ? t("Earlier passwords that cannot be used again, from 0 to 1024.")
                    : t("Earlier passwords that cannot be used again, from 0 to 24."))}
            </FormGroup>
            <FormGroup label={t("Minimum age")} fieldId={`${id}-minAge`}>
                {numberInput("minAge")}
                {help(t("Days before a user can change the password again; 0 for no wait."))}
            </FormGroup>
            <FormGroup label={t("Maximum age")} fieldId={`${id}-maxAge`}>
                {numberInput("maxAge")}
                {neverBox("maxAge", t("Passwords never expire"))}
                {help(t("Days after which a password must be changed."))}
            </FormGroup>
            <FormGroup label={t("Lockout threshold")} fieldId={`${id}-threshold`}>
                {numberInput("threshold")}
                {help(t("Failed logons that lock the account; 0: accounts are never locked."))}
            </FormGroup>
            <FormGroup label={t("Lockout duration")} fieldId={`${id}-duration`}>
                {numberInput("duration")}
                {neverBox("duration", t("Until an administrator unlocks the account"))}
                {help(t("Minutes a locked account stays locked."))}
            </FormGroup>
            <FormGroup label={t("Reset failed logons after")} fieldId={`${id}-resetAfter`}>
                {numberInput("resetAfter")}
                {neverBox("resetAfter", t("Never"))}
                {help(t("Minutes after which the count of failed logons starts again; at most the lockout duration."))}
            </FormGroup>
        </>
    );
}
