import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
    TextInputGroup, TextInputGroupMain, TextInputGroupUtilities,
    Button,
    FormHelperText, HelperText, HelperTextItem,
} from "@patternfly/react-core";
import { EyeIcon, EyeSlashIcon, KeyIcon, CheckCircleIcon } from "@patternfly/react-icons";
import type { PasswordPolicy } from "../lib/types.ts";
import type { CopyState } from "../lib/hooks.ts";

interface PasswordFieldProps {
    id: string;
    // The label of its form group: the input's accessible name
    label: string;
    value: string;
    onChange: (v: string) => void;
    isDisabled?: boolean;
    isRequired?: boolean;
    forceReveal?: number;
    onGenerate?: () => void;
    copyState?: CopyState;
}

export function PasswordField({ id, label, value, onChange, isDisabled, isRequired, forceReveal, onGenerate, copyState }: PasswordFieldProps) {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (forceReveal) setVisible(true);
    }, [forceReveal]);

    function handleGenerate() {
        onGenerate?.();
        setVisible(true);
    }

    return (
        <>
            <TextInputGroup isDisabled={isDisabled}>
                {/* TextInputGroupMain puts id on its <div> and names the input
                    "Type to filter": the id and the name go on the input */}
                <TextInputGroupMain
                    inputId={id}
                    aria-label={label}
                    type={visible ? "text" : "password"}
                    value={value}
                    onChange={(_e, v) => onChange(v)}
                    inputProps={isRequired ? { "aria-required": true } : undefined}
                />
                <TextInputGroupUtilities>
                    {onGenerate && (
                        <Button
                            variant="plain"
                            aria-label={t("Generate password")}
                            onClick={handleGenerate}
                            isDisabled={isDisabled}
                            tabIndex={-1}
                        >
                            {copyState === "copied"
                                ? <CheckCircleIcon style={{ color: "var(--pf-v6-global--success-color--100, green)" }} />
                                : <KeyIcon />}
                        </Button>
                    )}
                    <Button
                        variant="plain"
                        aria-label={visible ? t("Hide password") : t("Show password")}
                        onClick={() => setVisible(v => !v)}
                        isDisabled={isDisabled}
                        tabIndex={-1}
                    >
                        {visible ? <EyeSlashIcon /> : <EyeIcon />}
                    </Button>
                </TextInputGroupUtilities>
            </TextInputGroup>
            {copyState === "failed" && (
                <FormHelperText>
                    <HelperText>
                        <HelperTextItem variant="warning">
                            {t("Automatic clipboard copy failed. Copy the password manually.")}
                        </HelperTextItem>
                    </HelperText>
                </FormHelperText>
            )}
        </>
    );
}

export function PasswordPolicyUnavailable() {
    const { t } = useTranslation();

    return (
        <FormHelperText>
            <HelperText>
                <HelperTextItem variant="warning">
                    {t("Failed to load password policy.")}
                </HelperTextItem>
            </HelperText>
        </FormHelperText>
    );
}

interface PasswordPolicyInfoProps {
    policy: PasswordPolicy;
    // Where the policy comes from, for a user: a PSO's name, or null for the
    // domain's; left out where it is always the domain's
    pso?: string | null;
}

export function PasswordPolicyInfo({ policy, pso }: PasswordPolicyInfoProps) {
    const { t } = useTranslation();

    return (
        <FormHelperText>
            <HelperText>
                {pso !== undefined && (
                    <HelperTextItem>
                        {pso === null
                            ? t("The domain password policy applies.")
                            : t("The fine-grained policy {{name}} applies.", { name: pso })}
                    </HelperTextItem>
                )}
                <HelperTextItem>
                    {t("Minimum length: {{n}} characters", { n: policy.minLength })}
                </HelperTextItem>
                {policy.complexityRequired && (
                    <HelperTextItem>
                        {t("Complexity required: uppercase, lowercase, digit, symbol")}
                    </HelperTextItem>
                )}
                {policy.historyLength > 0 && (
                    <HelperTextItem>
                        {t("Last {{n}} passwords cannot be reused", { n: policy.historyLength })}
                    </HelperTextItem>
                )}
            </HelperText>
        </FormHelperText>
    );
}
