import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@patternfly/react-core";
import { listShares, sharesListing } from "../../lib/shares.ts";

interface Props {
    kind: "user" | "group";
    names: string[];
}

// Deleting an account leaves it in the shared folders that list it (an empty
// list would open a share to every domain user): say which before the delete.
export function SharesKeepingNotice({ kind, names }: Props) {
    const { t } = useTranslation();
    const [shares, setShares] = useState<string[]>([]);
    const key = names.join("\n");

    useEffect(() => {
        let live = true;
        listShares()
            .then(all => {
                if (!live) return;
                const found = new Set(key.split("\n").flatMap(n => sharesListing(all, kind, n)));
                setShares([...found].sort((a, b) => a.localeCompare(b)));
            })
            // Only a help: without the list, the delete works the same
            .catch(() => undefined);
        return () => { live = false; };
    }, [kind, key]);

    if (shares.length === 0) return null;
    return (
        <Alert variant="info" isInline style={{ marginBottom: "1rem" }}
            title={t("shares_keep_listing", { count: shares.length })}>
            {shares.join(", ")}. {t("Remove them in the Shared folders tab.")}
        </Alert>
    );
}
