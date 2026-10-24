import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput, Checkbox, Switch,
    Button, Alert,
} from "@patternfly/react-core";
import { setPasswordPolicy } from "../../lib/samba.ts";
import { validatePasswordPolicy, passwordPolicyViolationMessage } from "../../lib/validators.ts";
import type { PasswordPolicy } from "../../lib/types.ts";

interface Props { policy: PasswordPolicy; onClose: () => void; onSuccess: () => void; }

// A number field, with a check box for "never" when the setting allows it
interface Field {
    value: string;
    never: boolean;
}

function field(value: number | null): Field {
    return { value: value === null ? "" : String(value), never: value === null };
}

function parse(f: Field): number {
    return f.value.trim() === "" ? NaN : Number(f.value);
}

export function PasswordPolicyModal({ policy, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [complexity, setComplexity] = useState(policy.complexityRequired);
    const [minLength, setMinLength] = useState(field(policy.minLength));
    const [history, setHistory] = useState(field(policy.historyLength));
    const [minAge, setMinAge] = useState(field(policy.minAgeDays));
    const [maxAge, setMaxAge] = useState(field(policy.maxAgeDays));
    const [threshold, setThreshold] = useState(field(policy.lockoutThreshold));
    const [duration, setDuration] = useState(field(policy.lockoutDurationMinutes));
    const [resetAfter, setResetAfter] = useState(field(policy.lockoutWindowMinutes));
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSave() {
        const wanted: PasswordPolicy = {
            complexityRequired: complexity,
            minLength: parse(minLength),
            historyLength: parse(history),
            minAgeDays: parse(minAge),
            maxAgeDays: maxAge.never ? null : parse(maxAge),
            lockoutThreshold: parse(threshold),
            lockoutDurationMinutes: duration.never ? null : parse(duration),
            lockoutWindowMinutes: resetAfter.never ? null : parse(resetAfter),
        };
        const violation = validatePasswordPolicy(wanted);
        if (violation) { setError(passwordPolicyViolationMessage(t, violation)); return; }
        setSubmitting(true);
        setError(null);
        try {
            await setPasswordPolicy(policy, wanted);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    function numberInput(id: string, f: Field, set: (f: Field) => void) {
        return (
            <TextInput
                id={id}
                type="number"
                min={0}
                value={f.never ? "" : f.value}
                isDisabled={f.never}
                onChange={(_e, v) => set({ ...f, value: v })}
                style={{ maxWidth: "10rem" }}
            />
        );
    }

    function neverBox(id: string, label: string, f: Field, set: (f: Field) => void) {
        return (
            <Checkbox
                id={id}
                label={label}
                isChecked={f.never}
                onChange={(_e, checked) => set({ value: f.value, never: checked })}
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
        <Modal variant={ModalVariant.medium} isOpen onClose={onClose}>
            <ModalHeader title={t("Edit password policy")} description={t("The policy of the whole domain: it applies to every account.")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Complexity")} fieldId="pp-complexity">
                        <Switch
                            id="pp-complexity"
                            label={t("Passwords must be complex")}
                            isChecked={complexity}
                            onChange={(_e, checked) => setComplexity(checked)}
                        />
                        {help(t("Three of: uppercase, lowercase, digits, symbols; not the account name."))}
                    </FormGroup>
                    <FormGroup label={t("Minimum length")} fieldId="pp-min-length">
                        {numberInput("pp-min-length", minLength, setMinLength)}
                        {help(t("Characters, from 0 to 14."))}
                    </FormGroup>
                    <FormGroup label={t("Password history")} fieldId="pp-history">
                        {numberInput("pp-history", history, setHistory)}
                        {help(t("Earlier passwords that cannot be used again, from 0 to 24."))}
                    </FormGroup>
                    <FormGroup label={t("Minimum age")} fieldId="pp-min-age">
                        {numberInput("pp-min-age", minAge, setMinAge)}
                        {help(t("Days before a user can change the password again; 0 for no wait."))}
                    </FormGroup>
                    <FormGroup label={t("Maximum age")} fieldId="pp-max-age">
                        {numberInput("pp-max-age", maxAge, setMaxAge)}
                        {neverBox("pp-max-age-never", t("Passwords never expire"), maxAge, setMaxAge)}
                        {help(t("Days after which a password must be changed."))}
                    </FormGroup>
                    <FormGroup label={t("Lockout threshold")} fieldId="pp-threshold">
                        {numberInput("pp-threshold", threshold, setThreshold)}
                        {help(t("Failed logons that lock the account; 0: accounts are never locked."))}
                    </FormGroup>
                    <FormGroup label={t("Lockout duration")} fieldId="pp-duration">
                        {numberInput("pp-duration", duration, setDuration)}
                        {neverBox("pp-duration-never", t("Until an administrator unlocks the account"), duration, setDuration)}
                        {help(t("Minutes a locked account stays locked."))}
                    </FormGroup>
                    <FormGroup label={t("Reset failed logons after")} fieldId="pp-window">
                        {numberInput("pp-window", resetAfter, setResetAfter)}
                        {neverBox("pp-window-never", t("Never"), resetAfter, setResetAfter)}
                        {help(t("Minutes after which the count of failed logons starts again; at most the lockout duration."))}
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="save" variant="primary" isLoading={submitting} isDisabled={submitting} onClick={handleSave}>{t("Save")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
