import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput,
    FormHelperText, HelperText, HelperTextItem,
    Button, Alert,
} from "@patternfly/react-core";
import { createComputer } from "../../lib/samba.ts";
import { validateComputerName, computerNameViolationMessage } from "../../lib/validators.ts";
import { useOus } from "../../lib/hooks.ts";
import { ContainerSelect, accountContainers } from "../ContainerSelect.tsx";

interface Props { onClose: () => void; onSuccess: () => void; }

// An account made before the computer joins, so that it lands in the right OU
export function CreateComputerModal({ onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [ou, setOu] = useState("");
    const { ous } = useOus();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit() {
        const trimmed = name.trim();
        const violation = validateComputerName(trimmed);
        if (violation) { setError(computerNameViolationMessage(t, violation)); return; }
        setSubmitting(true);
        setError(null);
        try {
            await createComputer(trimmed, { description: description.trim(), ou });
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Create computer account")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form>
                    <FormGroup label={t("Computer name")} isRequired fieldId="cc-name">
                        <TextInput id="cc-name" value={name} onChange={(_e, v) => setName(v)} isRequired
                            isDisabled={submitting} />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {t("The name the computer will have when it joins the domain.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormGroup label={t("Description")} fieldId="cc-description">
                        <TextInput id="cc-description" value={description} onChange={(_e, v) => setDescription(v)}
                            placeholder={t("Optional")} isDisabled={submitting} />
                    </FormGroup>
                    <FormGroup label={t("Container")} fieldId="cc-ou">
                        <ContainerSelect id="cc-ou" value={ou} onChange={setOu}
                            choices={accountContainers(ous).filter(o => o.defaultFor !== "computers")}
                            emptyLabel={t("Default (Computers)")} isDisabled={submitting} />
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
