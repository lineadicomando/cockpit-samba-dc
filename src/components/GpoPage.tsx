import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, EmptyState, Label, LabelGroup, PageSection, Pagination, SearchInput, Spinner,
    Toolbar, ToolbarContent, ToolbarItem,
} from "@patternfly/react-core";
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";

import { listGpos } from "../lib/gpos.ts";
import { useSingleLoad, usePagination, PER_PAGE_OPTIONS } from "../lib/hooks.ts";
import type { Gpo, GpoLink } from "../lib/types.ts";
import { ContainerLabel } from "./ContainerSelect.tsx";
import { GpoLinksModal } from "./modals/GpoLinksModal.tsx";

export function GpoLinkLabel({ link }: { link: GpoLink }) {
    const { t } = useTranslation();
    const flags = [link.enforced && t("enforced"), link.disabled && t("disabled")].filter(Boolean).join(", ");
    return (
        <Label isCompact color={link.disabled ? "grey" : link.enforced ? "orange" : "blue"}>
            <ContainerLabel dn={link.container} />{flags && ` (${flags})`}
        </Label>
    );
}

export function GpoPage({ refreshToken = 0 }: { refreshToken?: number }) {
    const { t } = useTranslation();
    const { items: gpos, loading, error, reload, refresh, reloadFresh } = useSingleLoad(listGpos);
    // An OU renamed or deleted in another tab changes the links
    useEffect(() => {
        if (refreshToken > 0) refresh();
    }, [refreshToken, refresh]);
    const [search, setSearch] = useState("");
    const [managing, setManaging] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return gpos.filter(g => !q || g.name.toLowerCase().includes(q) || g.guid.toLowerCase().includes(q));
    }, [gpos, search]);
    const { page, perPage, paginated, onSetPage, onPerPageSelect } = usePagination(filtered, search);
    const selected = gpos.find(g => g.guid === managing);

    function status(g: Gpo): string {
        if (g.userEnabled && g.computerEnabled) return t("Enabled");
        if (g.userEnabled) return t("Computer settings disabled");
        if (g.computerEnabled) return t("User settings disabled");
        return t("Disabled");
    }

    return (
        <PageSection>
            <Toolbar>
                <ToolbarContent>
                    <ToolbarItem>
                        <SearchInput placeholder={t("Filter GPOs")} value={search}
                            onChange={(_e, v) => setSearch(v)} onClear={() => setSearch("")}
                            aria-label={t("Filter GPOs")} />
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button variant="secondary" onClick={reloadFresh} isDisabled={loading}>{t("Refresh")}</Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>

            {error && (
                <Alert variant="danger" isInline title={t("Failed to load Group Policy objects")}
                    style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            {loading && (
                <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner aria-label={t("Loading Group Policy objects")} />
                </div>
            )}

            {!loading && !error && filtered.length === 0 && (
                <EmptyState titleText={search ? t("No GPOs match the filter") : t("No GPOs")} headingLevel="h4" />
            )}

            {!loading && filtered.length > 0 && (
                <Table aria-label={t("Group Policy objects table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Name")}</Th>
                            <Th>{t("Linked to")}</Th>
                            <Th>{t("Status")}</Th>
                            <Th>{t("Version")}</Th>
                            <Th aria-label={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {paginated.map(g => (
                            <Tr key={g.guid}>
                                <Td dataLabel={t("Name")}>
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", flexWrap: "wrap" }}>
                                        <span title={g.guid}>{g.name}</span>
                                        {g.builtIn && <Label isCompact color="orange">{t("Built-in")}</Label>}
                                        {g.driveMapping && <Label isCompact color="purple" title={t("Maps the drives of the shared folders")}>{t("Mapped drives")}</Label>}
                                    </span>
                                </Td>
                                <Td dataLabel={t("Linked to")}>
                                    {g.links.length === 0
                                        ? <span className="pf-v6-u-text-color-subtle">{t("Not linked")}</span>
                                        : (
                                            <LabelGroup numLabels={4}>
                                                {g.links.map(l => <GpoLinkLabel key={l.container} link={l} />)}
                                            </LabelGroup>
                                        )}
                                </Td>
                                <Td dataLabel={t("Status")}>{status(g)}</Td>
                                <Td dataLabel={t("Version")} title={t("User {{user}}, computer {{computer}}", g.version)}>
                                    {`${g.version.user} / ${g.version.computer}`}
                                </Td>
                                <Td isActionCell>
                                    <ActionsColumn items={[{ title: t("Manage links"), onClick: () => setManaging(g.guid) }]} />
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

            {selected && (
                <GpoLinksModal gpo={selected} onClose={() => { setManaging(null); reload(); }} />
            )}
        </PageSection>
    );
}
