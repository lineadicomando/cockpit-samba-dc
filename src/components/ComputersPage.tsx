import React, { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert,
    Button,
    EmptyState,
    EmptyStateBody,
    Label,
    PageSection,
    Pagination,
    SearchInput,
    Spinner,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from "@patternfly/react-core";
import {
    ActionsColumn,
    Table,
    Tbody,
    Td,
    Th,
    Thead,
    Tr,
} from "@patternfly/react-table";
import type { IAction } from "@patternfly/react-table";
import cockpit from "cockpit";

import { listComputers } from "../lib/samba.ts";
import { useSingleLoad, usePagination, useOus, useSelection, PER_PAGE_OPTIONS } from "../lib/hooks.ts";
import type { Computer } from "../lib/types.ts";
import { DeleteComputerModal } from "./modals/DeleteComputerModal.tsx";
import { MoveModal } from "./modals/MoveModal.tsx";
import { CreateComputerModal } from "./modals/CreateComputerModal.tsx";
import { ContainerFilter, ContainerLabel, sameContainer } from "./ContainerSelect.tsx";

// ---------------------------------------------------------------------------
// ComputersPage
// ---------------------------------------------------------------------------
type ModalState =
    | { kind: "none" }
    | { kind: "create" }
    | { kind: "delete"; computer: Computer }
    | { kind: "move"; computers: Computer[] };

interface Props {
    // Bumped when OUs change (renaming or moving one moves the computers in
    // it), and on the way back from a computer's page
    refreshToken?: number;
}

export function ComputersPage({ refreshToken = 0 }: Props) {
    const { t } = useTranslation();
    const {
        items: computers,
        setItems: setComputers,
        loading,
        error,
        reload: loadComputers,
        reloadFresh: loadComputersFresh,
        refresh: refreshComputers,
    } = useSingleLoad(listComputers);
    const { ous, reload: reloadOus } = useOus();

    useEffect(() => {
        if (refreshToken > 0) { refreshComputers(); reloadOus(); }
    }, [refreshToken, refreshComputers, reloadOus]);

    const [search, setSearch] = useState("");
    const [containerFilter, setContainerFilter] = useState<string | null>(null);
    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    const filtered = useMemo<Computer[]>(() => {
        let result = computers;
        if (containerFilter !== null) result = result.filter(c => sameContainer(c.container, containerFilter));
        if (!search) return result;
        const q = search.toLowerCase();
        return result.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q) ||
            c.os.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q)
        );
    }, [computers, search, containerFilter]);

    const { page, perPage, paginated, onSetPage, onPerPageSelect } =
        usePagination(filtered, `${search}\x1f${containerFilter ?? ""}`);
    const { selected, setSelected, allSelected, selectAll, selectRow } = useSelection(filtered, c => c.name);
    const selectedComputers = useMemo(() => computers.filter(c => selected.has(c.name)), [computers, selected]);

    function rowActions(computer: Computer): IAction[] {
        return [
            {
                title: t("Details"),
                onClick: () => cockpit.location.go(["computers", computer.name]),
            },
            {
                title: t("Move"),
                onClick: () => setModal({ kind: "move", computers: [computer] }),
                isDisabled: computer.isDomainController,
            },
            { isSeparator: true, title: "" },
            {
                title: t("Delete computer"),
                onClick: () => setModal({ kind: "delete", computer }),
                isDisabled: computer.isDomainController,
                isDanger: true,
            },
        ];
    }

    return (
        <PageSection>
            {/* ---- Toolbar ---- */}
            <Toolbar>
                <ToolbarContent>
                    <ToolbarItem>
                        <SearchInput
                            placeholder={t("Filter by name, description, OS or ID")}
                            value={search}
                            onChange={(_evt, val) => setSearch(val)}
                            onClear={() => setSearch("")}
                            aria-label={t("Filter computers")}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <ContainerFilter ous={ous} value={containerFilter} onChange={setContainerFilter} />
                    </ToolbarItem>
                    <ToolbarItem>
                        <Label color="blue">{t("computers_count", { count: computers.length })}</Label>
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button variant="primary" onClick={() => setModal({ kind: "create" })}>
                            {t("Create computer account")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button
                            variant="secondary"
                            onClick={loadComputersFresh}
                            isDisabled={loading}
                        >
                            {t("Refresh")}
                        </Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>

            {/* ---- Bulk actions ---- */}
            {selected.size > 0 && (
                <Toolbar>
                    <ToolbarContent>
                        <ToolbarItem>
                            <Label color="blue">{t("computers_selected", { count: selected.size })}</Label>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="link" onClick={() => setSelected(new Set())}>{t("Clear selection")}</Button>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="secondary"
                                onClick={() => setModal({ kind: "move", computers: selectedComputers })}>
                                {t("Move")}
                            </Button>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>
            )}

            {/* ---- Inline errors ---- */}
            {error && (
                <Alert variant="danger" isInline title={t("Failed to load computers")} style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            {/* ---- Loading spinner ---- */}
            {loading && (
                <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner aria-label={t("Loading computers")} />
                </div>
            )}

            {/* ---- Empty state ---- */}
            {!loading && !error && filtered.length === 0 && (
                <EmptyState
                    titleText={search || containerFilter !== null ? t("No computers match the filter") : t("No computers found")}
                    headingLevel="h4"
                >
                    <EmptyStateBody>
                        {search || containerFilter !== null
                            ? t("Try clearing the search or container filter.")
                            : t("No domain computers are available.")}
                    </EmptyStateBody>
                </EmptyState>
            )}

            {/* ---- Computers table ---- */}
            {!loading && filtered.length > 0 && (
                <Table aria-label={t("Computers table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th select={{ onSelect: (_e, isSelected) => selectAll(isSelected), isSelected: allSelected }} />
                            <Th>{t("Name")}</Th>
                            <Th>{t("Description")}</Th>
                            <Th>{t("ID")}</Th>
                            <Th>{t("OS")}</Th>
                            <Th>{t("Last logon")}</Th>
                            <Th>{t("Container")}</Th>
                            <Th aria-label={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {paginated.map((c, idx) => (
                            <Tr key={c.name}>
                                <Td select={{ rowIndex: idx, onSelect: (_e, isSelected) => selectRow(c.name, isSelected),
                                    isSelected: selected.has(c.name) }} />
                                <Td dataLabel={t("Name")}>
                                    <Button variant="link" isInline
                                        onClick={() => cockpit.location.go(["computers", c.name])}>
                                        {c.name}
                                    </Button>
                                </Td>
                                <Td dataLabel={t("Description")}>{c.description}</Td>
                                <Td dataLabel={t("ID")}>{c.id}</Td>
                                <Td dataLabel={t("OS")}>{c.os}</Td>
                                <Td dataLabel={t("Last logon")}>{c.lastLogon || t("Never")}</Td>
                                <Td dataLabel={t("Container")}><ContainerLabel dn={c.container} /></Td>
                                <Td isActionCell>
                                    <ActionsColumn items={rowActions(c)} />
                                </Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            )}

            {/* ---- Pagination ---- */}
            {!loading && filtered.length > 0 && (
                <Pagination
                    itemCount={filtered.length}
                    perPage={perPage}
                    page={page}
                    onSetPage={onSetPage}
                    onPerPageSelect={onPerPageSelect}
                    perPageOptions={PER_PAGE_OPTIONS}
                />
            )}

            {/* ---- Modals ---- */}
            {modal.kind === "create" && (
                <CreateComputerModal
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => { setModal({ kind: "none" }); loadComputers(); }}
                />
            )}
            {modal.kind === "move" && (
                <MoveModal
                    kind="computer"
                    items={modal.computers.map(c => ({ name: c.name, container: c.container, fixed: c.isDomainController }))}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => { setModal({ kind: "none" }); setSelected(new Set()); loadComputers(); }}
                />
            )}
            {modal.kind === "delete" && (
                <DeleteComputerModal
                    computer={modal.computer}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => {
                        const name = modal.computer.name;
                        setModal({ kind: "none" });
                        setComputers(prev => prev.filter(c => c.name !== name) as Computer[]);
                    }}
                />
            )}
        </PageSection>
    );
}
