import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Button, Alert, Content,
} from "@patternfly/react-core";
import { resetSysvolAcls } from "../../lib/domain.ts";

interface Props { onClose: () => void; onSuccess: () => void; }

export function SysvolResetModal({ onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleReset() {
        setSubmitting(true);
        setError(null);
        try {
            await resetSysvolAcls();
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Reset sysvol ACLs")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Content component="p">
                    {t("This runs samba-tool ntacl sysvolreset, which sets the ACLs of every file in sysvol, the Group Policy files included, to what Samba expects.")}
                </Content>
            </ModalBody>
            <ModalFooter>
                <Button key="reset" variant="warning" isLoading={submitting} isDisabled={submitting} onClick={handleReset}>
                    {t("Reset")}
                </Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
