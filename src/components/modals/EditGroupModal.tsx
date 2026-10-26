import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput,
    FormHelperText, HelperText, HelperTextItem,
    Button, Alert,
} from "@patternfly/react-core";
import { updateGroup } from "../../lib/samba.ts";
import {
    validateGroupName, groupNameViolationMessage, validateEmail, emailViolationMessage,
} from "../../lib/validators.ts";
import type { Group } from "../../lib/types.ts";

interface Props { group: Group; onClose: () => void; onSuccess: () => void; }

// Name, description and e-mail of a group; built-in groups keep their name
export function EditGroupModal({ group, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState(group.name);
    const [description, setDescription] = useState(group.description);
    const [email, setEmail] = useState(group.email);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const unchanged = name.trim() === group.name && description === group.description && email === group.email;

    async function handleSave() {
        const trimmed = name.trim();
        const violation = validateGroupName(trimmed);
        if (violation) { setError(groupNameViolationMessage(t, violation)); return; }
        const emailViolation = validateEmail(email.trim());
        if (emailViolation) { setError(emailViolationMessage(t, emailViolation)); return; }
        setSubmitting(true);
        setError(null);
        try {
            await updateGroup(group.name, {
                newName: trimmed,
                description: description !== group.description ? description.trim() : undefined,
                email: email !== group.email ? email.trim() : undefined,
            });
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Edit group: {{name}}", { name: group.name })} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form>
                    <FormGroup label={t("Group name")} isRequired fieldId="eg-name">
                        <TextInput id="eg-name" value={name} onChange={(_e, v) => setName(v)} isRequired
                            isDisabled={submitting || group.isProtected} />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {group.isProtected
                                        ? t("Built-in groups cannot be renamed.")
                                        : t("Shared folders follow the new name.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormGroup label={t("Description")} fieldId="eg-description">
                        <TextInput id="eg-description" value={description} onChange={(_e, v) => setDescription(v)}
                            isDisabled={submitting} />
                    </FormGroup>
                    <FormGroup label={t("Email")} fieldId="eg-email">
                        <TextInput id="eg-email" type="email" value={email} onChange={(_e, v) => setEmail(v)}
                            isDisabled={submitting} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="save" variant="primary" isLoading={submitting} isDisabled={submitting || unchanged}
                    onClick={handleSave}>{t("Save")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
