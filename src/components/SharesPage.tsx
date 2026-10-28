import React, { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert,
    Button,
    EmptyState,
    EmptyStateBody,
    Label,
    LabelGroup,
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
import { UserIcon, UsersIcon } from "@patternfly/react-icons";

import { listShares, registrySharesServed } from "../lib/shares.ts";
import { useSingleLoad, usePagination, PER_PAGE_OPTIONS } from "../lib/hooks.ts";
import type { SharedFolder } from "../lib/types.ts";
import { ShareModal } from "./modals/ShareModal.tsx";
import { DeleteShareModal } from "./modals/DeleteShareModal.tsx";

type ModalState =
    | { kind: "none" }
    | { kind: "create" }
    | { kind: "edit"; share: SharedFolder }
    | { kind: "delete"; share: SharedFolder };

export function SharesPage() {
    const { t } = useTranslation();
    const {
        items: shares,
        setItems: setShares,
        loading,
        error,
        reload: loadShares,
        reloadFresh: loadSharesFresh,
    } = useSingleLoad(listShares);

    const [served, setServed] = useState(true);
    useEffect(() => {
        // From the cached list: no call of its own
        registrySharesServed().then(setServed).catch(() => undefined);
    }, [shares]);

    const [search, setSearch] = useState("");
    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    const filtered = useMemo<SharedFolder[]>(() => {
        const sorted = [...shares].sort((a, b) => a.name.localeCompare(b.name));
        if (!search) return sorted;
        const q = search.toLowerCase();
        return sorted.filter(s =>
            s.name.toLowerCase().includes(q) ||
            s.comment.toLowerCase().includes(q) ||
            s.access.some(a => a.name.toLowerCase().includes(q))
        );
    }, [shares, search]);

    const { page, perPage, paginated, onSetPage, onPerPageSelect } = usePagination(filtered, search);

    function rowActions(s: SharedFolder): IAction[] {
        return [
            { title: t("Edit"), onClick: () => setModal({ kind: "edit", share: s }) },
            { isSeparator: true, title: "" },
            {
                title: t("Delete shared folder"),
                onClick: () => setModal({ kind: "delete", share: s }),
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
                            placeholder={t("Filter shared folders")}
                            value={search}
                            onChange={(_evt, val) => setSearch(val)}
                            onClear={() => setSearch("")}
                            aria-label={t("Filter shared folders")}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <Label color="blue">{t("shares_count", { count: shares.length })}</Label>
                    </ToolbarItem>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button variant="primary" onClick={() => setModal({ kind: "create" })}>
                            {t("Create shared folder")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button variant="secondary" onClick={loadSharesFresh} isDisabled={loading}>
                            {t("Refresh")}
                        </Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>

            {!served && (
                <Alert variant="warning" isInline title={t("Samba does not serve these shares")} style={{ marginBottom: "1rem" }}>
                    {t("smb.conf lacks \"registry shares = yes\" in its [global] section, so no shared folder or home directory can be reached, and none can be created. Add it and restart samba-ad-dc.")}
                </Alert>
            )}

            {/* ---- Inline errors ---- */}
            {error && (
                <Alert variant="danger" isInline title={t("Failed to load shared folders")} style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            {/* ---- Loading spinner ---- */}
            {loading && (
                <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner aria-label={t("Loading shared folders")} />
                </div>
            )}

            {/* ---- Empty state ---- */}
            {!loading && !error && filtered.length === 0 && (
                <EmptyState
                    titleText={search ? t("No shared folders match the filter") : t("No shared folders")}
                    headingLevel="h4"
                >
                    <EmptyStateBody>
                        {search
                            ? t("Try clearing the search.")
                            : t("Create a shared folder to give users and groups a common place for their files.")}
                    </EmptyStateBody>
                </EmptyState>
            )}

            {/* ---- Shares table ---- */}
            {!loading && filtered.length > 0 && (
                <Table aria-label={t("Shared folders table")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Name")}</Th>
                            <Th>{t("Description")}</Th>
                            <Th>{t("Access")}</Th>
                            <Th>{t("Drive")}</Th>
                            <Th>{t("Folder")}</Th>
                            <Th screenReaderText={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {paginated.map(s => (
                            <Tr key={s.name}>
                                <Td dataLabel={t("Name")}>
                                    {s.name}
                                    {!s.browseable && (
                                        <Label isCompact color="grey" style={{ marginLeft: "0.5rem" }}>{t("Hidden")}</Label>
                                    )}
                                </Td>
                                <Td dataLabel={t("Description")}>{s.comment}</Td>
                                <Td dataLabel={t("Access")}>
                                    <LabelGroup numLabels={4} expandedText={t("Show less")} collapsedText={t("and_n_more", { count: s.access.length - 4 })}>
                                        {s.access.map(a => (
                                            <Label
                                                key={`${a.kind}:${a.name}`}
                                                isCompact
                                                color={a.unknown ? "orange" : a.level === "write" ? "blue" : "grey"}
                                                icon={a.kind === "group" ? <UsersIcon /> : <UserIcon />}
                                            >
                                                {a.unknown
                                                    ? t("{{name}} (deleted)", { name: a.name })
                                                    : a.level === "write" ? a.name : t("{{name}} (read only)", { name: a.name })}
                                            </Label>
                                        ))}
                                    </LabelGroup>
                                </Td>
                                <Td dataLabel={t("Drive")}>
                                    {s.automount ? `${s.automount.letter}: ${s.automount.label}` : "—"}
                                </Td>
                                <Td dataLabel={t("Folder")}><code>{s.path}</code></Td>
                                <Td isActionCell>
                                    <ActionsColumn items={rowActions(s)} />
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
            {(modal.kind === "create" || modal.kind === "edit") && (
                <ShareModal
                    share={modal.kind === "edit" ? modal.share : undefined}
                    existingNames={shares.map(s => s.name)}
                    usedLetters={shares
                        .filter(s => s.automount && !(modal.kind === "edit" && s.name === modal.share.name))
                        .map(s => s.automount!.letter)}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => { setModal({ kind: "none" }); loadShares(); }}
                />
            )}
            {modal.kind === "delete" && (
                <DeleteShareModal
                    share={modal.share}
                    onClose={() => setModal({ kind: "none" })}
                    onSuccess={() => {
                        const name = modal.share.name;
                        setModal({ kind: "none" });
                        setShares(prev => prev.filter(s => s.name !== name));
                    }}
                />
            )}
        </PageSection>
    );
}
