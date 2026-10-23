import React, { useState, useMemo } from "react";
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

import { listComputers } from "../lib/samba.ts";
import { useSingleLoad, usePagination, PER_PAGE_OPTIONS } from "../lib/hooks.ts";
import type { Computer } from "../lib/types.ts";
import { DeleteComputerModal } from "./modals/DeleteComputerModal.tsx";

// ---------------------------------------------------------------------------
// ComputersPage
// ---------------------------------------------------------------------------
type ModalState =
    | { kind: "none" }
    | { kind: "delete"; computer: Computer };

export function ComputersPage() {
    const { t } = useTranslation();
    const {
        items: computers,
        setItems: setComputers,
        loading,
        error,
        reload: loadComputers,
        reloadFresh: loadComputersFresh,
    } = useSingleLoad(listComputers);

    const [search, setSearch] = useState("");
    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    const filtered = useMemo<Computer[]>(() => {
        if (!search) return computers;
        const q = search.toLowerCase();
        return computers.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.os.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q)
        );
    }, [computers, search]);

    const { page, perPage, paginated, onSetPage, onPerPageSelect } = usePagination(filtered, search);

    function rowActions(computer: Computer): IAction[] {
        return [
            {
                title: t("Delete computer"),
                onClick: () => setModal({ kind: "delete", computer }),
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
                            placeholder={t("Filter by name, OS or ID")}
                            value={search}
                            onChange={(_evt, val) => setSearch(val)}
                            onClear={() => setSearch("")}
                            aria-label={t("Filter computers")}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <Label color="blue">{t("computers_count", { count: computers.length })}</Label>
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
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
                    titleText={search ? t("No computers match the filter") : t("No computers found")}
                    headingLevel="h4"
                >
                    <EmptyStateBody>
                        {search ? t("Try clearing the search filter.") : t("No domain computers are available.")}
                    </EmptyStateBody>
                </EmptyState>
            )}

            {/* ---- Computers table ---- */}
            {!loading && filtered.length > 0 && (
                <Table aria-label={t("Computers table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Name")}</Th>
                            <Th>{t("ID")}</Th>
                            <Th>{t("OS")}</Th>
                            <Th>{t("Last logon")}</Th>
                            <Th aria-label={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {paginated.map(c => (
                            <Tr key={c.name}>
                                <Td dataLabel={t("Name")}>{c.name}</Td>
                                <Td dataLabel={t("ID")}>{c.id}</Td>
                                <Td dataLabel={t("OS")}>{c.os}</Td>
                                <Td dataLabel={t("Last logon")}>{c.lastLogon || t("Never")}</Td>
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
