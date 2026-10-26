import React, { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert,
    Button,
    EmptyState,
    EmptyStateBody,
    Label,
    MenuToggle,
    PageSection,
    Pagination,
    SearchInput,
    Select,
    SelectList,
    SelectOption,
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

import { listGroups, refreshGroup } from "../lib/samba.ts";
import { useSingleLoad, usePagination, useOus, useSelection, PER_PAGE_OPTIONS } from "../lib/hooks.ts";
import type { Group } from "../lib/types.ts";
import { CreateGroupModal } from "./modals/CreateGroupModal.tsx";
import { ManageMembersModal } from "./modals/ManageMembersModal.tsx";
import { DeleteGroupModal } from "./modals/DeleteGroupModal.tsx";
import { EditGroupModal } from "./modals/EditGroupModal.tsx";
import { MoveModal } from "./modals/MoveModal.tsx";
import { ContainerFilter, ContainerLabel, sameContainer } from "./ContainerSelect.tsx";

// ---------------------------------------------------------------------------
// GroupsPage
// ---------------------------------------------------------------------------
type ModalState =
    | { kind: "none" }
    | { kind: "create" }
    | { kind: "manageMembers"; group: Group }
    | { kind: "edit"; group: Group }
    | { kind: "move"; groups: Group[] }
    | { kind: "delete"; group: Group };

interface Props {
    // See UsersPage: member counts change when groups are edited from the
    // user detail page.
    refreshToken?: number;
}

export function GroupsPage({ refreshToken = 0 }: Props) {
    const { t } = useTranslation();
    const {
        items: groups,
        setItems: setGroups,
        loading,
        error,
        reload: loadGroups,
        reloadFresh: loadGroupsFresh,
        refresh: refreshGroups,
    } = useSingleLoad(listGroups);

    const { ous, reload: reloadOus } = useOus();

    useEffect(() => {
        if (refreshToken > 0) { refreshGroups(); reloadOus(); }
    }, [refreshToken, refreshGroups, reloadOus]);

    const [search, setSearch] = useState("");
    const [typeFilter, setTypeFilter] = useState<"all" | "protected" | "custom">("all");
    const [typeSelectOpen, setTypeSelectOpen] = useState(false);
    const [containerFilter, setContainerFilter] = useState<string | null>(null);
    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    const filtered = useMemo<Group[]>(() => {
        let result = groups;
        if (search) {
            const q = search.toLowerCase();
            result = result.filter(g =>
                g.name.toLowerCase().includes(q) ||
                g.description.toLowerCase().includes(q)
            );
        }
        if (typeFilter !== "all")
            result = result.filter(g => g.isProtected === (typeFilter === "protected"));
        if (containerFilter !== null)
            result = result.filter(g => sameContainer(g.container, containerFilter));
        return result;
    }, [groups, search, typeFilter, containerFilter]);

    const { page, perPage, paginated, onSetPage, onPerPageSelect } =
        usePagination(filtered, `${search}\x1f${typeFilter}\x1f${containerFilter ?? ""}`);
    const filtering = Boolean(search) || typeFilter !== "all" || containerFilter !== null;
    const { selected, setSelected, allSelected, selectAll, selectRow } = useSelection(filtered, g => g.name);
    const selectedGroups = useMemo(() => groups.filter(g => selected.has(g.name)), [groups, selected]);

    function rowActions(g: Group): IAction[] {
        return [
            {
                title: t("Manage members"),
                onClick: () => setModal({ kind: "manageMembers", group: g }),
            },
            {
                title: t("Edit group"),
                onClick: () => setModal({ kind: "edit", group: g }),
            },
            {
                title: t("Move"),
                onClick: () => setModal({ kind: "move", groups: [g] }),
                isDisabled: g.isProtected,
            },
            { isSeparator: true, title: "" },
            {
                title: t("Delete group"),
                onClick: () => setModal({ kind: "delete", group: g }),
                isDisabled: g.isProtected,
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
                            placeholder={t("Filter by name or description")}
                            value={search}
                            onChange={(_evt, val) => setSearch(val)}
                            onClear={() => setSearch("")}
                            aria-label={t("Filter groups")}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <Select
                            isOpen={typeSelectOpen}
                            onOpenChange={setTypeSelectOpen}
                            onSelect={(_evt, val) => {
                                setTypeFilter(val as "all" | "protected" | "custom");
                                setTypeSelectOpen(false);
                            }}
                            selected={typeFilter}
                            toggle={(ref) => (
                                <MenuToggle
                                    ref={ref}
                                    onClick={() => setTypeSelectOpen((o) => !o)}
                                    isExpanded={typeSelectOpen}
                                >
                                    {typeFilter === "all" ? t("All types") : typeFilter === "protected" ? t("Protected") : t("Custom")}
                                </MenuToggle>
                            )}
                        >
                            <SelectList>
                                <SelectOption value="all">{t("All types")}</SelectOption>
                                <SelectOption value="protected">{t("Protected")}</SelectOption>
                                <SelectOption value="custom">{t("Custom")}</SelectOption>
                            </SelectList>
                        </Select>
                    </ToolbarItem>
                    <ToolbarItem>
                        <ContainerFilter ous={ous} value={containerFilter} onChange={setContainerFilter} />
                    </ToolbarItem>
                    <ToolbarItem>
                        <Label color="blue">{t("groups_count", { count: groups.length })}</Label>
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button
                            variant="primary"
                            onClick={() => setModal({ kind: "create" })}
                        >
                            {t("Create group")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button
                            variant="secondary"
                            onClick={loadGroupsFresh}
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
                            <Label color="blue">{t("groups_selected", { count: selected.size })}</Label>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="link" onClick={() => setSelected(new Set())}>{t("Clear selection")}</Button>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="secondary" onClick={() => setModal({ kind: "move", groups: selectedGroups })}>
                                {t("Move")}
                            </Button>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>
            )}

            {/* ---- Inline errors ---- */}
            {error && (
                <Alert variant="danger" isInline title={t("Failed to load groups")} style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            {/* ---- Loading spinner ---- */}
            {loading && (
                <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner aria-label={t("Loading groups")} />
                </div>
            )}

            {/* ---- Empty state ---- */}
            {!loading && !error && filtered.length === 0 && (
                <EmptyState
                    titleText={filtering ? t("No groups match the filter") : t("No groups found")}
                    headingLevel="h4"
                >
                    <EmptyStateBody>
                        {filtering
                            ? t("Try clearing the search, type or container filter.")
                            : t("No domain groups are available.")}
                    </EmptyStateBody>
                </EmptyState>
            )}

            {/* ---- Groups table ---- */}
            {!loading && filtered.length > 0 && (
                <Table aria-label={t("Groups table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th select={{ onSelect: (_e, isSelected) => selectAll(isSelected), isSelected: allSelected }} />
                            <Th>{t("Name")}</Th>
                            <Th>{t("Description")}</Th>
                            <Th>{t("ID")}</Th>
                            <Th>{t("Members")}</Th>
                            <Th>{t("Type")}</Th>
                            <Th>{t("Container")}</Th>
                            <Th aria-label={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {paginated.map((g, idx) => (
                            <Tr key={g.name}>
                                <Td select={{ rowIndex: idx, onSelect: (_e, isSelected) => selectRow(g.name, isSelected),
                                    isSelected: selected.has(g.name) }} />
                                <Td dataLabel={t("Name")}>{g.name}</Td>
                                <Td dataLabel={t("Description")}>{g.description}</Td>
                                <Td dataLabel={t("ID")}>{g.id}</Td>
                                <Td dataLabel={t("Members")}>{g.memberCount}</Td>
                                <Td dataLabel={t("Type")}>
                                    {g.isProtected
                                        ? <Label color="orange">{t("Protected")}</Label>
                                        : <Label color="blue">{t("Custom")}</Label>}
                                </Td>
                                <Td dataLabel={t("Container")}><ContainerLabel dn={g.container} /></Td>
                                <Td isActionCell>
                                    <ActionsColumn items={rowActions(g)} />
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
                <CreateGroupModal
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => { setModal({ kind: "none" }); loadGroups(); }}
                />
            )}
            {modal.kind === "manageMembers" && (
                <ManageMembersModal
                    group={modal.group}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={async () => {
                        const groupName = modal.group.name;
                        setModal({ kind: "none" });
                        try {
                            const updated = await refreshGroup(groupName);
                            setGroups(prev => prev.map(g => g.name === groupName ? updated : g) as Group[]);
                        } catch {
                            // stale member count is acceptable; user can refresh manually
                        }
                    }}
                />
            )}
            {modal.kind === "edit" && (
                <EditGroupModal
                    group={modal.group}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => { setModal({ kind: "none" }); loadGroups(); }}
                />
            )}
            {modal.kind === "move" && (
                <MoveModal
                    kind="group"
                    items={modal.groups.map(g => ({ name: g.name, container: g.container, fixed: g.isProtected }))}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => { setModal({ kind: "none" }); setSelected(new Set()); loadGroups(); }}
                />
            )}
            {modal.kind === "delete" && (
                <DeleteGroupModal
                    group={modal.group}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => {
                        const groupName = modal.group.name;
                        setModal({ kind: "none" });
                        setGroups(prev => prev.filter(g => g.name !== groupName));
                    }}
                />
            )}
        </PageSection>
    );
}
