import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput,
    Button, Alert,
} from "@patternfly/react-core";
import { createGroup } from "../../lib/samba.ts";
import { validateGroupName, groupNameViolationMessage } from "../../lib/validators.ts";
import { useOus } from "../../lib/hooks.ts";
import { ContainerSelect, accountContainers } from "../ContainerSelect.tsx";

interface Props { onClose: () => void; onSuccess: () => void; }

export function CreateGroupModal({ onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [ou, setOu] = useState("");
    const { ous } = useOus();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit() {
        const violation = validateGroupName(name.trim());
        if (violation) { setError(groupNameViolationMessage(t, violation)); return; }
        setSubmitting(true);
        setError(null);
        try {
            await createGroup(name.trim(), ou);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Create group")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form>
                    <FormGroup label={t("Group name")} isRequired fieldId="cg-name">
                        <TextInput id="cg-name" value={name} onChange={(_e, v) => setName(v)} isRequired />
                    </FormGroup>
                    <FormGroup label={t("Container")} fieldId="cg-ou">
                        <ContainerSelect id="cg-ou" value={ou} onChange={setOu}
                            choices={accountContainers(ous).filter(o => o.defaultFor !== "users")}
                            emptyLabel={t("Default (Users)")} isDisabled={submitting} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="create" variant="primary" isLoading={submitting} onClick={handleSubmit}>{t("Create")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
