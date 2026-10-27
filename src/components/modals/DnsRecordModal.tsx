import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Form, FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem,
    Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant, TextArea, TextInput,
} from "@patternfly/react-core";
import { setDnsRecords } from "../../lib/dns.ts";
import {
    dnsNameViolationMessage, dnsValueViolationMessage, validateDnsName, validateDnsValue,
} from "../../lib/validators.ts";
import type { DnsRecord, DnsRecordType } from "../../lib/types.ts";

export const DNS_RECORD_TYPES: DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "PTR", "SRV", "TXT"];

interface Props {
    zone: string;
    // The zone's records: those of the name and type being edited fill the form
    records: DnsRecord[];
    // Edit the records of this name and type; without it, add records
    edit?: { name: string; type: DnsRecordType };
    onClose: () => void;
    onSuccess: () => void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function DnsRecordModal({ zone, records, edit, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const current = edit ? records.filter(r => same(r.name, edit.name) && r.type === edit.type) : [];
    const [name, setName] = useState(edit?.name ?? "");
    const [type, setType] = useState<DnsRecordType>(edit?.type ?? "A");
    const [values, setValues] = useState(current.map(r => r.value).join("\n"));
    const [ttl, setTtl] = useState(current.length > 0 ? String(current[0].ttl) : "");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const placeholders: Record<DnsRecordType, string> = {
        A: "192.168.1.10", AAAA: "2001:db8::10", CNAME: "server.example.com", PTR: "server.example.com",
        MX: "mail.example.com 10", SRV: "sip.example.com 5060 0 100", TXT: "v=spf1 mx -all",
    };

    async function handleSubmit() {
        const trimmed = name.trim();
        const nameViolation = validateDnsName(trimmed);
        if (nameViolation) { setError(dnsNameViolationMessage(t, nameViolation)); return; }
        const list = values.split("\n").map(v => (type === "TXT" ? v : v.trim())).filter(v => v.trim());
        if (list.length === 0) { setError(t("Give at least one value.")); return; }
        for (const v of list) {
            const violation = validateDnsValue(type, v);
            if (violation) { setError(`${v}: ${dnsValueViolationMessage(t, violation)}`); return; }
        }
        const seconds = ttl.trim() ? Number(ttl.trim()) : undefined;
        if (seconds !== undefined && !(Number.isInteger(seconds) && seconds >= 0 && seconds <= 2147483647)) {
            setError(t("The TTL is a whole number of seconds."));
            return;
        }
        // Adding to a name and type that already have records keeps them
        const existing = edit ? [] : records.filter(r => same(r.name, trimmed) && r.type === type).map(r => r.value);
        setSubmitting(true);
        setError(null);
        try {
            await setDnsRecords(zone, trimmed, type, [...existing, ...list], seconds);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    const title = edit
        ? t("Edit {{type}} records of {{name}}", { type: edit.type, name: edit.name })
        : t("Add record to {{zone}}", { zone });

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={title} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form onSubmit={e => { e.preventDefault(); handleSubmit(); }}>
                    <FormGroup label={t("Name")} isRequired fieldId="dns-name">
                        <TextInput id="dns-name" value={name} onChange={(_e, v) => setName(v)} isRequired
                            isDisabled={Boolean(edit) || submitting} placeholder="www" />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>{t("Relative to {{zone}}; @ for the zone itself.", { zone })}</HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormGroup label={t("Type")} fieldId="dns-type">
                        <FormSelect id="dns-type" value={type} onChange={(_e, v) => setType(v as DnsRecordType)}
                            isDisabled={Boolean(edit) || submitting}>
                            {DNS_RECORD_TYPES.map(rt => <FormSelectOption key={rt} value={rt} label={rt} />)}
                        </FormSelect>
                    </FormGroup>
                    <FormGroup label={t("Values")} isRequired fieldId="dns-values">
                        <TextArea id="dns-values" value={values} onChange={(_e, v) => setValues(v)} rows={3}
                            resizeOrientation="vertical" placeholder={placeholders[type]} isDisabled={submitting} />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {edit
                                        ? t("One per line: these values replace the current ones.")
                                        : t("One per line; records of this name and type that exist already are kept.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormGroup label={t("TTL (seconds)")} fieldId="dns-ttl">
                        <TextInput id="dns-ttl" type="number" min={0} value={ttl} onChange={(_e, v) => setTtl(v)}
                            placeholder="900" isDisabled={submitting} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" isLoading={submitting} isDisabled={submitting} onClick={handleSubmit}>
                    {edit ? t("Save") : t("Add")}
                </Button>
                <Button variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
