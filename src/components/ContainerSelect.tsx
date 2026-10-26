import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    FormSelect, FormSelectOption,
    MenuToggle, SearchInput, Select, SelectList, SelectOption,
} from "@patternfly/react-core";
import { containerPath } from "../lib/samba.ts";
import type { Ou } from "../lib/types.ts";

// Where accounts can be: an OU or a default container, not Domain Controllers
export function accountContainers(ous: Ou[]): Ou[] {
    return ous.filter(o => o.defaultFor !== "domain_controllers");
}

function isUnder(dn: string, ancestor: string): boolean {
    const d = dn.toLowerCase(), a = ancestor.toLowerCase();
    return d === a || d.endsWith("," + a);
}

// Where an OU can be: the domain itself or another OU, never inside itself
export function ouParents(ous: Ou[], moving?: string): Ou[] {
    return ous.filter(o => o.isOu && o.defaultFor !== "domain_controllers" && !(moving && isUnder(o.dn, moving)));
}

// The container's path for a column, "School/Students"
export function ContainerLabel({ dn }: { dn: string }) {
    const { t } = useTranslation();
    return <span title={dn} style={{ whiteSpace: "nowrap" }}>{dn ? containerPath(dn) : t("Domain")}</span>;
}

interface SelectProps {
    id: string;
    // DN relative to the domain; "" for the option of emptyLabel
    value: string;
    onChange: (dn: string) => void;
    choices: Ou[];
    // Option for "": the default container, or the domain itself
    emptyLabel?: string;
    isDisabled?: boolean;
}

export function ContainerSelect({ id, value, onChange, choices, emptyLabel, isDisabled }: SelectProps) {
    const { t } = useTranslation();
    const known = choices.some(o => o.dn.toLowerCase() === value.toLowerCase());
    return (
        <FormSelect id={id} value={value} onChange={(_e, v) => onChange(v)} isDisabled={isDisabled}
            aria-label={t("Container")}>
            {emptyLabel !== undefined && <FormSelectOption value="" label={emptyLabel} />}
            {/* The current value, while the list loads */}
            {!known && value && <FormSelectOption value={value} label={containerPath(value)} />}
            {choices.map(o => (
                <FormSelectOption key={o.dn} value={o.dn} label={o.path} />
            ))}
        </FormSelect>
    );
}

interface FilterProps {
    ous: Ou[];
    // null: every container
    value: string | null;
    onChange: (dn: string | null) => void;
}

export function ContainerFilter({ ous, value, onChange }: FilterProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const shown = ous.filter(o => o.path.toLowerCase().includes(search.toLowerCase()));
    return (
        <Select
            isOpen={open}
            onOpenChange={isOpen => { setOpen(isOpen); if (!isOpen) setSearch(""); }}
            onSelect={(_e, v) => { onChange(v === "\x1fall" ? null : String(v)); setOpen(false); }}
            selected={value ?? "\x1fall"}
            toggle={ref => (
                <MenuToggle ref={ref} onClick={() => setOpen(o => !o)} isExpanded={open}>
                    {value === null ? t("All containers") : containerPath(value) || t("Domain")}
                </MenuToggle>
            )}
        >
            <div style={{ padding: "4px 8px" }}>
                <SearchInput
                    value={search}
                    onChange={(_e, v) => setSearch(v)}
                    onClear={() => setSearch("")}
                    placeholder={t("Filter containers…")}
                    onClick={e => e.stopPropagation()}
                />
            </div>
            <SelectList style={{ maxHeight: "240px", overflowY: "auto" }}>
                {!search && <SelectOption value={"\x1fall"}>{t("All containers")}</SelectOption>}
                {shown.map(o => (
                    <SelectOption key={o.dn} value={o.dn}>{o.path}</SelectOption>
                ))}
            </SelectList>
        </Select>
    );
}

// Same container, whatever the case of the DN
export function sameContainer(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}
