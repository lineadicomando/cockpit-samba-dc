import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Form, FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput,
    Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant,
} from "@patternfly/react-core";
import { createOu, updateOu } from "../../lib/samba.ts";
import { validateOuName, ouNameViolationMessage } from "../../lib/validators.ts";
import type { Ou } from "../../lib/types.ts";
import { ContainerSelect, ouParents } from "../ContainerSelect.tsx";

interface Props {
    ous: Ou[];
    // Edit this OU; without it, create one in parent
    ou?: Ou;
    parent?: string;
    onClose: () => void;
    onSuccess: () => void;
}

export function OuModal({ ous, ou, parent = "", onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState(ou?.name ?? "");
    const [parentDn, setParentDn] = useState(ou?.parent ?? parent);
    const [description, setDescription] = useState(ou?.description ?? "");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    // The default containers keep their name and place
    const fixed = Boolean(ou?.builtIn);

    async function handleSubmit() {
        const trimmed = name.trim();
        const violation = validateOuName(trimmed);
        if (violation && !fixed) { setError(ouNameViolationMessage(t, violation)); return; }
        setSubmitting(true);
        setError(null);
        try {
            if (ou) await updateOu(ou, { name: fixed ? ou.name : trimmed, parent: fixed ? ou.parent : parentDn, description });
            else await createOu(trimmed, parentDn, description.trim());
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={ou ? t("Edit {{name}}", { name: ou.path }) : t("Create organizational unit")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form onSubmit={e => { e.preventDefault(); handleSubmit(); }}>
                    <FormGroup label={t("Name")} isRequired fieldId="ou-name">
                        <TextInput id="ou-name" value={name} onChange={(_e, v) => setName(v)} isRequired
                            isDisabled={fixed || submitting} />
                    </FormGroup>
                    <FormGroup label={t("In")} fieldId="ou-parent">
                        <ContainerSelect id="ou-parent" value={parentDn} onChange={setParentDn}
                            choices={ouParents(ous, ou?.dn)} emptyLabel={t("Domain")} isDisabled={fixed || submitting} />
                        {ou && !fixed && (
                            <FormHelperText>
                                <HelperText>
                                    <HelperTextItem>
                                        {t("Renaming or moving an OU takes everything in it along.")}
                                    </HelperTextItem>
                                </HelperText>
                            </FormHelperText>
                        )}
                    </FormGroup>
                    <FormGroup label={t("Description")} fieldId="ou-description">
                        <TextInput id="ou-description" value={description} onChange={(_e, v) => setDescription(v)}
                            placeholder={t("Optional")} isDisabled={submitting} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" isLoading={submitting} isDisabled={submitting} onClick={handleSubmit}>
                    {ou ? t("Save") : t("Create")}
                </Button>
                <Button variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
