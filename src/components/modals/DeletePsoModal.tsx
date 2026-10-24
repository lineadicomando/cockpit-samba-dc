import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Content, Button, Alert,
} from "@patternfly/react-core";
import { deletePso } from "../../lib/samba.ts";
import type { Pso } from "../../lib/types.ts";

interface Props { pso: Pso; onClose: () => void; onSuccess: () => void; }

export function DeletePsoModal({ pso, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleDelete() {
        setSubmitting(true);
        setError(null);
        try {
            await deletePso(pso.name);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Delete fine-grained policy: {{name}}", { name: pso.name })} titleIconVariant="warning" />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Content component="p">
                    {pso.appliesTo.length > 0
                        ? t("Its users and groups ({{names}}) get the next fine-grained policy that applies to them, or the domain policy.", { names: pso.appliesTo.join(", ") })
                        : t("It applies to no user or group.")}
                </Content>
            </ModalBody>
            <ModalFooter>
                <Button key="delete" variant="danger" isLoading={submitting} isDisabled={submitting} onClick={handleDelete}>{t("Delete")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
