import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Checkbox, EmptyState, EmptyStateBody, FormSelect, FormSelectOption, Label, PageSection,
    Pagination, SearchInput, Spinner, Toolbar, ToolbarContent, ToolbarItem,
} from "@patternfly/react-core";
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";
import type { IAction } from "@patternfly/react-table";

import { listDnsRecords, listDnsZones } from "../lib/dns.ts";
import { useSingleLoad, usePagination, PER_PAGE_OPTIONS } from "../lib/hooks.ts";
import type { DnsRecord, DnsRecordType } from "../lib/types.ts";
import { DnsRecordModal, DNS_RECORD_TYPES } from "./modals/DnsRecordModal.tsx";
import { DeleteDnsRecordModal } from "./modals/DeleteDnsRecordModal.tsx";

type ModalState =
    | { kind: "none" }
    | { kind: "create" }
    | { kind: "edit"; name: string; type: DnsRecordType }
    | { kind: "delete"; record: DnsRecord };

const isEditable = (type: string): type is DnsRecordType => (DNS_RECORD_TYPES as string[]).includes(type);

export function DnsPage() {
    const { t } = useTranslation();
    const { items: zones, error: zonesError } = useSingleLoad(listDnsZones);
    const [zoneName, setZoneName] = useState("");
    const [search, setSearch] = useState("");
    const [showDomain, setShowDomain] = useState(false);
    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    // The domain's zone first: the first one that can be changed
    useEffect(() => {
        if (!zoneName && zones.length > 0) setZoneName((zones.find(z => !z.readOnly) ?? zones[0]).name);
    }, [zones, zoneName]);
    const zone = zones.find(z => z.name === zoneName);

    const loadRecords = useCallback(() => (zoneName ? listDnsRecords(zoneName) : Promise.resolve([])), [zoneName]);
    const { items: records, loading, error, reload, reloadFresh } = useSingleLoad(loadRecords);

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return records.filter(r => (showDomain || !r.protected) &&
            (!q || r.name.toLowerCase().includes(q) || r.value.toLowerCase().includes(q) ||
             r.type.toLowerCase() === q));
    }, [records, search, showDomain]);
    const hidden = records.filter(r => r.protected).length;

    const { page, perPage, paginated, onSetPage, onPerPageSelect } =
        usePagination(filtered, `${zoneName}\x1f${search}\x1f${showDomain}`);

    function rowActions(r: DnsRecord): IAction[] {
        if (r.protected || !isEditable(r.type)) return [];
        const type = r.type;
        return [
            { title: t("Edit"), onClick: () => setModal({ kind: "edit", name: r.name, type }) },
            { isSeparator: true, title: "" },
            { title: t("Delete"), onClick: () => setModal({ kind: "delete", record: r }), isDanger: true },
        ];
    }

    const done = () => { setModal({ kind: "none" }); reload(); };
    const readOnly = zone?.readOnly ?? true;

    return (
        <PageSection>
            <Toolbar>
                <ToolbarContent>
                    <ToolbarItem>
                        <FormSelect value={zoneName} onChange={(_e, v) => setZoneName(v)} aria-label={t("DNS zone")}
                            style={{ minWidth: "14rem" }}>
                            {zones.map(z => <FormSelectOption key={z.name} value={z.name} label={z.name} />)}
                        </FormSelect>
                    </ToolbarItem>
                    <ToolbarItem>
                        <SearchInput placeholder={t("Filter records")} value={search}
                            onChange={(_e, v) => setSearch(v)} onClear={() => setSearch("")}
                            aria-label={t("Filter records")} />
                    </ToolbarItem>
                    <ToolbarItem alignSelf="center">
                        <Checkbox id="dns-show-domain" isChecked={showDomain} onChange={(_e, v) => setShowDomain(v)}
                            label={t("Show the domain's records ({{n}})", { n: hidden })} />
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button variant="primary" onClick={() => setModal({ kind: "create" })} isDisabled={readOnly}>
                            {t("Add record")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button variant="secondary" onClick={reloadFresh} isDisabled={loading}>{t("Refresh")}</Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>

            {zone?.readOnly && (
                <Alert variant="info" isInline title={t("This zone belongs to the domain: its records cannot be changed.")}
                    style={{ marginBottom: "1rem" }} />
            )}

            {(zonesError || error) && (
                <Alert variant="danger" isInline title={t("Failed to load DNS records")} style={{ marginBottom: "1rem" }}>
                    {zonesError || error}
                </Alert>
            )}

            {loading && (
                <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner aria-label={t("Loading DNS records")} />
                </div>
            )}

            {!loading && !error && filtered.length === 0 && (
                <EmptyState titleText={search ? t("No records match the filter") : t("No records")} headingLevel="h4">
                    {!search && !readOnly && <EmptyStateBody>{t("Records the domain depends on are hidden; add your own with Add record.")}</EmptyStateBody>}
                </EmptyState>
            )}

            {!loading && filtered.length > 0 && (
                <Table aria-label={t("DNS records table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Name")}</Th>
                            <Th>{t("Type")}</Th>
                            <Th>{t("Value")}</Th>
                            <Th>{t("TTL")}</Th>
                            <Th aria-label={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {paginated.map(r => (
                            <Tr key={`${r.name}\x1f${r.type}\x1f${r.value}`}>
                                <Td dataLabel={t("Name")}>
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", flexWrap: "wrap" }}>
                                        {r.name}
                                        {r.protected && <Label isCompact color="orange">{t("Domain")}</Label>}
                                        {r.dynamic && <Label isCompact color="grey" title={t("Registered by the computer itself")}>{t("Dynamic")}</Label>}
                                    </span>
                                </Td>
                                <Td dataLabel={t("Type")}>{r.type}</Td>
                                <Td dataLabel={t("Value")} style={{ wordBreak: "break-all" }}>{r.value}</Td>
                                <Td dataLabel={t("TTL")}>{r.ttl}</Td>
                                <Td isActionCell>
                                    {rowActions(r).length > 0 && <ActionsColumn items={rowActions(r)} />}
                                </Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            )}

            {!loading && filtered.length > 0 && (
                <Pagination itemCount={filtered.length} perPage={perPage} page={page} onSetPage={onSetPage}
                    onPerPageSelect={onPerPageSelect} perPageOptions={PER_PAGE_OPTIONS} />
            )}

            {modal.kind === "create" && zone && (
                <DnsRecordModal zone={zone.name} records={records} onClose={() => setModal({ kind: "none" })}
                    onSuccess={done} />
            )}
            {modal.kind === "edit" && zone && (
                <DnsRecordModal zone={zone.name} records={records} edit={{ name: modal.name, type: modal.type }}
                    onClose={() => setModal({ kind: "none" })} onSuccess={done} />
            )}
            {modal.kind === "delete" && zone && (
                <DeleteDnsRecordModal zone={zone.name} record={modal.record} onClose={() => setModal({ kind: "none" })}
                    onSuccess={done} />
            )}
        </PageSection>
    );
}
