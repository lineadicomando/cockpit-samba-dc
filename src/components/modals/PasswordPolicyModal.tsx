import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, Button, Alert,
} from "@patternfly/react-core";
import { setPasswordPolicy } from "../../lib/samba.ts";
import { validatePasswordPolicy, passwordPolicyViolationMessage } from "../../lib/validators.ts";
import type { PasswordPolicy } from "../../lib/types.ts";
import { PasswordPolicyFields, policyForm, policyFromForm } from "../PasswordPolicyFields.tsx";

interface Props { policy: PasswordPolicy; onClose: () => void; onSuccess: () => void; }

export function PasswordPolicyModal({ policy, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [form, setForm] = useState(() => policyForm(policy));
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSave() {
        const wanted = policyFromForm(form);
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

    return (
        <Modal variant={ModalVariant.medium} isOpen onClose={onClose}>
            <ModalHeader title={t("Edit password policy")} description={t("The policy of the whole domain: it applies to every account without a fine-grained policy.")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <PasswordPolicyFields id="pp" form={form} onChange={setForm} />
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="save" variant="primary" isLoading={submitting} isDisabled={submitting} onClick={handleSave}>{t("Save")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
