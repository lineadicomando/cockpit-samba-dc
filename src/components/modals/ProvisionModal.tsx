import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter, Button, Alert, Content, CodeBlock, CodeBlockCode,
    Spinner, Flex, FlexItem,
} from "@patternfly/react-core";
import type { NewDomain } from "../../lib/types.ts";
import { provisionDomain } from "../../lib/domain.ts";

interface Props {
    domain: NewDomain;
    // What addcctl --check reports it would do
    commands: string[];
    onClose: () => void;
    onSuccess: () => void;
}

export function ProvisionModal({ domain, commands, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);

    async function handleProvision() {
        setRunning(true);
        setError(null);
        try {
            await provisionDomain(domain);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setRunning(false);
        }
    }

    return (
        <Modal variant={ModalVariant.medium} isOpen onClose={running ? undefined : onClose}>
            <ModalHeader title={t("Create the domain {{realm}}", { realm: domain.realm.toUpperCase() })} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Content component="p">
                    {t("This host becomes the domain controller of a new domain, {{netbios}}. Samba's file server is replaced by the domain controller, and these changes are made on the host:",
                       { netbios: domain.netbiosDomain })}
                </Content>
                <CodeBlock>
                    <CodeBlockCode>{commands.join("\n")}</CodeBlockCode>
                </CodeBlock>
                <Content component="p" style={{ marginTop: "1rem" }}>
                    {t("Keep the administrator password: it is the only account that can manage the new domain.")}
                </Content>
                {running && (
                    <Flex style={{ marginTop: "1rem" }} alignItems={{ default: "alignItemsCenter" }}>
                        <FlexItem><Spinner size="md" aria-label={t("Creating the domain")} /></FlexItem>
                        <FlexItem>{t("Creating the domain: this takes less than a minute.")}</FlexItem>
                    </Flex>
                )}
            </ModalBody>
            <ModalFooter>
                <Button key="provision" variant="danger" isLoading={running} isDisabled={running} onClick={handleProvision}>
                    {t("Create the domain")}
                </Button>
                <Button key="cancel" variant="link" onClick={onClose} isDisabled={running}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
