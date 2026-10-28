import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant,
    ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput,
    Button, Alert,
} from "@patternfly/react-core";
import { deleteUser } from "../../lib/samba.ts";
import { SharesKeepingNotice } from "./SharesKeepingNotice.tsx";

interface Props {
    user: { username: string };
    onClose: () => void;
    onSuccess: () => void;
}

export function DeleteUserModal({ user, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleDelete() {
        if (confirm !== user.username) {
            setError(t("type_name_to_confirm_exact", { name: user.username }));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            await deleteUser(user.username);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal
            variant={ModalVariant.small}
            isOpen
            onClose={onClose}
        >
            <ModalHeader title={t("Delete user: {{name}}", { name: user.username })} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <SharesKeepingNotice kind="user" names={[user.username]} />
                <Form>
                    <FormGroup label={t("type_name_to_confirm", { name: user.username })} isRequired fieldId="du-confirm">
                        <TextInput id="du-confirm" value={confirm} onChange={(_e, v) => setConfirm(v)} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="delete" variant="danger" isLoading={submitting}
                    isDisabled={confirm !== user.username} onClick={handleDelete}>{t("Delete")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
