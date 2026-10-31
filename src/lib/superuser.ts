import { useEffect, useState } from "react";
import cockpit from "cockpit";

// Whether the session has administrative access, followed as Cockpit's own
// pages do (pkg/lib/superuser.js): the cockpit.Superuser interface on the
// internal bus, whose Current is "none" with limited access and "init" while
// it is being decided. null until known.
export function useSuperuserAllowed(): boolean | null {
    const [allowed, setAllowed] = useState<boolean | null>(null);

    useEffect(() => {
        const client = cockpit.dbus(null, { bus: "internal" });
        const proxy = client.proxy("cockpit.Superuser", "/superuser");
        const update = () => {
            setAllowed(!proxy.valid || proxy.Current === "init" ? null : proxy.Current !== "none");
        };
        proxy.addEventListener("changed", update);
        void proxy.wait(update);
        return () => {
            proxy.removeEventListener("changed", update);
            client.close();
        };
    }, []);

    return allowed;
}
