import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, EmptyState, EmptyStateBody, Label, LabelGroup, PageSection, Spinner,
    Toolbar, ToolbarContent, ToolbarItem,
} from "@patternfly/react-core";
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";
import type { IAction } from "@patternfly/react-table";
import { AngleDownIcon, AngleRightIcon } from "@patternfly/react-icons";

import { listComputers, listGroups, listOus, listUsers } from "../lib/samba.ts";
import { listGpos } from "../lib/gpos.ts";
import { useSingleLoad } from "../lib/hooks.ts";
import { forgetCachedData } from "../lib/exec.ts";
import type { Gpo, GpoLink, Ou } from "../lib/types.ts";
import { OuModal } from "./modals/OuModal.tsx";
import { DeleteOuModal, type OuContents } from "./modals/DeleteOuModal.tsx";
import { GpoLinksModal } from "./modals/GpoLinksModal.tsx";

// An OU or default container with the accounts directly in it
interface Row {
    ou: Ou;
    depth: number;
    users: string[];
    groups: string[];
    computers: string[];
    // The GPOs linked to it, by precedence
    gpos: { gpo: Gpo; link: GpoLink }[];
}

function isUnder(dn: string, ancestor: string): boolean {
    const d = dn.toLowerCase(), a = ancestor.toLowerCase();
    return d === a || d.endsWith("," + a);
}

async function loadRows(): Promise<Row[]> {
    const [ous, users, groups, computers, gpos] = await Promise.all([
        listOus(), listUsers(), listGroups(), listComputers(),
        // The links are shown in passing: the "Group Policy" tab reports its errors
        listGpos().catch(() => [] as Gpo[]),
    ]);
    const known = new Set(ous.map(o => o.dn.toLowerCase()));
    const inIt = (container: string, dn: string) => container.toLowerCase() === dn.toLowerCase();
    return ous.map(ou => ({
        ou,
        // Depth among the listed ones: an OU below a container that is not
        // listed (none in practice) starts a level of its own
        depth: ou.parent && known.has(ou.parent.toLowerCase()) ? ou.path.split("/").length - 1 : 0,
        users: users.filter(u => inIt(u.container, ou.dn)).map(u => u.username),
        groups: groups.filter(g => inIt(g.container, ou.dn)).map(g => g.name),
        computers: computers.filter(c => inIt(c.container, ou.dn)).map(c => c.name),
        gpos: gpos.flatMap(gpo => gpo.links.filter(l => inIt(l.container, ou.dn)).map(link => ({ gpo, link })))
            .sort((a, b) => a.link.order - b.link.order),
    }));
}

type ModalState =
    | { kind: "none" }
    | { kind: "create"; parent: string }
    | { kind: "edit"; ou: Ou }
    | { kind: "delete"; ou: Ou; contents: OuContents }
    | { kind: "gpo"; gpo: Gpo };

interface Props {
    // Bumped when accounts change elsewhere (the counts follow)
    refreshToken?: number;
    // An OU was created, changed or deleted: the other lists show containers
    onChange?: () => void;
}

export function OusPage({ refreshToken = 0, onChange }: Props) {
    const { t } = useTranslation();
    const { items: rows, setItems: setRows, loading, error, reload, refresh, reloadFresh } = useSingleLoad(loadRows);
    const [actionError, setActionError] = useState<string | null>(null);

    useEffect(() => {
        if (refreshToken > 0) refresh();
    }, [refreshToken, refresh]);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    const ous = useMemo(() => rows.map(r => r.ou), [rows]);
    const hasChildren = useCallback(
        (dn: string) => rows.some(r => r.ou.parent.toLowerCase() === dn.toLowerCase()), [rows]);
    const visible = rows.filter(r => ![...collapsed].some(c => r.ou.dn.toLowerCase() !== c && isUnder(r.ou.dn, c)));

    function toggle(dn: string) {
        setCollapsed(prev => {
            const next = new Set(prev);
            const key = dn.toLowerCase();
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }

    function contents(all: Row[], ou: Ou): OuContents {
        const below = all.filter(r => isUnder(r.ou.dn, ou.dn));
        return {
            ous: below.filter(r => r.ou.dn !== ou.dn).map(r => r.ou.path),
            users: below.flatMap(r => r.users),
            groups: below.flatMap(r => r.groups),
            computers: below.flatMap(r => r.computers),
        };
    }

    function rowActions(ou: Ou): IAction[] {
        const canHoldOus = ou.isOu && ou.defaultFor !== "domain_controllers";
        return [
            ...(canHoldOus ? [{ title: t("Create OU in it"), onClick: () => setModal({ kind: "create", parent: ou.dn }) }] : []),
            { title: ou.builtIn ? t("Edit description") : t("Edit"), onClick: () => setModal({ kind: "edit", ou }) },
            { isSeparator: true, title: "" },
            {
                title: t("Delete"),
                onClick: () => { openDelete(ou); },
                isDisabled: ou.builtIn,
                isDanger: true,
            },
        ];
    }

    // What the confirmation lists is read again, not taken from the cache
    async function openDelete(ou: Ou) {
        setActionError(null);
        try {
            forgetCachedData();
            const fresh = await loadRows();
            setRows(fresh);
            const current = fresh.find(r => r.ou.dn.toLowerCase() === ou.dn.toLowerCase());
            if (current) setModal({ kind: "delete", ou: current.ou, contents: contents(fresh, current.ou) });
        } catch (e) {
            setActionError(e instanceof Error ? e.message : String(e));
        }
    }

    const done = () => { setModal({ kind: "none" }); reload(); onChange?.(); };
    const gpoFlags = (l: GpoLink) => [l.enforced && t("enforced"), l.disabled && t("disabled")].filter(Boolean).join(", ");

    return (
        <PageSection>
            <Toolbar>
                <ToolbarContent>
                    <ToolbarItem>
                        <Label color="blue">{t("ous_count", { count: rows.filter(r => !r.ou.builtIn).length })}</Label>
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button variant="primary" onClick={() => setModal({ kind: "create", parent: "" })}>
                            {t("Create organizational unit")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button variant="secondary" onClick={reloadFresh} isDisabled={loading}>{t("Refresh")}</Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>

            {error && (
                <Alert variant="danger" isInline title={t("Failed to load organizational units")} style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            {actionError && (
                <Alert variant="danger" isInline title={t("Action failed")} style={{ marginBottom: "1rem" }}>
                    {actionError}
                </Alert>
            )}

            {loading && (
                <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner aria-label={t("Loading organizational units")} />
                </div>
            )}

            {!loading && !error && rows.length === 0 && (
                <EmptyState titleText={t("No organizational units found")} headingLevel="h4">
                    <EmptyStateBody>{t("Create one to organize users, groups and computers.")}</EmptyStateBody>
                </EmptyState>
            )}

            {!loading && rows.length > 0 && (
                <Table aria-label={t("Organizational units table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Name")}</Th>
                            <Th>{t("Description")}</Th>
                            <Th>{t("Users")}</Th>
                            <Th>{t("Groups")}</Th>
                            <Th>{t("Computers")}</Th>
                            <Th>{t("Group Policy")}</Th>
                            <Th aria-label={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {visible.map(r => {
                            const open = !collapsed.has(r.ou.dn.toLowerCase());
                            return (
                                <Tr key={r.ou.dn}>
                                    <Td dataLabel={t("Name")}>
                                        <span style={{ paddingLeft: `${r.depth * 1.5}rem`, display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                                            {hasChildren(r.ou.dn) ? (
                                                <Button variant="plain" size="sm" onClick={() => toggle(r.ou.dn)}
                                                    aria-label={open ? t("Collapse") : t("Expand")} aria-expanded={open}
                                                    style={{ padding: 0 }}>
                                                    {open ? <AngleDownIcon /> : <AngleRightIcon />}
                                                </Button>
                                            ) : <span style={{ display: "inline-block", width: "1em" }} />}
                                            <span title={r.ou.dn}>{r.ou.name}</span>
                                            {r.ou.builtIn && <Label isCompact color="orange">{t("Built-in")}</Label>}
                                        </span>
                                    </Td>
                                    <Td dataLabel={t("Description")}>{r.ou.description}</Td>
                                    <Td dataLabel={t("Users")}>{r.users.length || ""}</Td>
                                    <Td dataLabel={t("Groups")}>{r.groups.length || ""}</Td>
                                    <Td dataLabel={t("Computers")}>{r.computers.length || ""}</Td>
                                    <Td dataLabel={t("Group Policy")}>
                                        <LabelGroup numLabels={3} expandedText={t("Show less")}
                                            collapsedText={t("and_n_more", { count: r.gpos.length - 3 })}>
                                            {r.gpos.map(({ gpo, link }) => (
                                                <Label key={gpo.guid} isCompact
                                                    color={link.disabled ? "grey" : link.enforced ? "orange" : "blue"}
                                                    onClick={() => setModal({ kind: "gpo", gpo })}>
                                                    {gpo.name}{gpoFlags(link) && ` (${gpoFlags(link)})`}
                                                </Label>
                                            ))}
                                        </LabelGroup>
                                    </Td>
                                    <Td isActionCell>
                                        <ActionsColumn items={rowActions(r.ou)} />
                                    </Td>
                                </Tr>
                            );
                        })}
                    </Tbody>
                </Table>
            )}

            {modal.kind === "create" && (
                <OuModal ous={ous} parent={modal.parent} onClose={() => setModal({ kind: "none" })} onSuccess={done} />
            )}
            {modal.kind === "edit" && (
                <OuModal ous={ous} ou={modal.ou} onClose={() => setModal({ kind: "none" })} onSuccess={done} />
            )}
            {modal.kind === "delete" && (
                <DeleteOuModal ou={modal.ou} contents={modal.contents} onClose={() => setModal({ kind: "none" })}
                    onSuccess={done} />
            )}
            {modal.kind === "gpo" && (
                <GpoLinksModal gpo={modal.gpo} onClose={() => { setModal({ kind: "none" }); reload(); }} />
            )}
        </PageSection>
    );
}
