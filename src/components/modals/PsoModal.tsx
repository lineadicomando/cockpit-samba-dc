import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, FormHelperText, HelperText, HelperTextItem, FormSection, TextInput,
    Button, Alert,
} from "@patternfly/react-core";
import { createPso, updatePso } from "../../lib/samba.ts";
import {
    validatePasswordPolicy, passwordPolicyViolationMessage, validatePso, psoViolationMessage,
} from "../../lib/validators.ts";
import type { PasswordPolicy, Pso } from "../../lib/types.ts";
import { PasswordPolicyFields, policyForm, policyFromForm } from "../PasswordPolicyFields.tsx";
import { PrincipalMultiSelect } from "../PrincipalMultiSelect.tsx";

interface Props {
    // The PSO to edit; without one, a new PSO starts from the domain policy
    pso?: Pso;
    domainPolicy: PasswordPolicy;
    onClose: () => void;
    onSuccess: () => void;
}

export function PsoModal({ pso, domainPolicy, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState(pso?.name ?? "");
    const [precedence, setPrecedence] = useState(String(pso?.precedence ?? 10));
    const [appliesTo, setAppliesTo] = useState<string[]>(pso?.appliesTo ?? []);
    const [form, setForm] = useState(() => policyForm(pso?.policy ?? domainPolicy));
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSave() {
        const wanted: Pso = {
            name,
            precedence: precedence.trim() === "" ? NaN : Number(precedence),
            appliesTo,
            policy: policyFromForm(form),
        };
        const psoViolation = validatePso(wanted.name, wanted.precedence);
        if (psoViolation) { setError(psoViolationMessage(t, psoViolation)); return; }
        const violation = validatePasswordPolicy(wanted.policy, true);
        if (violation) { setError(passwordPolicyViolationMessage(t, violation, true)); return; }
        setSubmitting(true);
        setError(null);
        try {
            if (pso) await updatePso(pso, wanted);
            else await createPso(wanted);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.medium} isOpen onClose={onClose}>
            <ModalHeader
                title={pso ? t("Edit fine-grained policy: {{name}}", { name: pso.name }) : t("Create fine-grained policy")}
                description={t("It replaces the domain policy for the users and groups it applies to.")}
            />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Name")} isRequired fieldId="pso-name">
                        <TextInput id="pso-name" value={name} isDisabled={!!pso} isRequired
                            onChange={(_e, v) => setName(v)} />
                    </FormGroup>
                    <FormGroup label={t("Precedence")} isRequired fieldId="pso-precedence">
                        <TextInput id="pso-precedence" type="number" min={1} value={precedence} isRequired
                            onChange={(_e, v) => setPrecedence(v)} style={{ maxWidth: "10rem" }} />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {t("When several policies apply to a user, the lowest precedence wins; one that names the user directly wins over its groups'.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormGroup label={t("Applies to")} fieldId="pso-applies-to">
                        <PrincipalMultiSelect selected={appliesTo} onChange={setAppliesTo} isDisabled={submitting} />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>{t("A group's policy applies to its members.")}</HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormSection title={t("Settings")} titleElement="h3">
                        <PasswordPolicyFields id="pso" form={form} onChange={setForm} pso />
                    </FormSection>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="save" variant="primary" isLoading={submitting} isDisabled={submitting} onClick={handleSave}>
                    {pso ? t("Save") : t("Create")}
                </Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
