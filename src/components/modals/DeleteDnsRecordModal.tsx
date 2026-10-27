import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Content, Button, Alert,
} from "@patternfly/react-core";
import { deleteDnsRecords } from "../../lib/dns.ts";
import type { DnsRecord, DnsRecordType } from "../../lib/types.ts";

interface Props { zone: string; record: DnsRecord; onClose: () => void; onSuccess: () => void; }

export function DeleteDnsRecordModal({ zone, record, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const full = record.name === "@" ? zone : `${record.name}.${zone}`;

    async function handleDelete() {
        setSubmitting(true);
        setError(null);
        try {
            await deleteDnsRecords(zone, record.name, record.type as DnsRecordType, [record.value]);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Delete DNS record")} titleIconVariant="warning" />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Content component="p">
                    {t("Delete the {{type}} record {{name}} → {{value}}?", { type: record.type, name: full, value: record.value })}
                </Content>
            </ModalBody>
            <ModalFooter>
                <Button key="delete" variant="danger" isLoading={submitting} isDisabled={submitting} onClick={handleDelete}>{t("Delete")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
