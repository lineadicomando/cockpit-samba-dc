import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Page,
  PageSection,
  Title,
  Flex,
  FlexItem,
  Tabs,
  Tab,
  TabTitleText,
  Alert,
  Spinner,
  Bullseye,
} from "@patternfly/react-core";
import { UsersPage } from "./components/UsersPage.tsx";
import { GroupsPage } from "./components/GroupsPage.tsx";
import { ComputersPage } from "./components/ComputersPage.tsx";
import { SharesPage } from "./components/SharesPage.tsx";
import { DomainPage } from "./components/DomainPage.tsx";
import { OusPage } from "./components/OusPage.tsx";
import { DnsPage } from "./components/DnsPage.tsx";
import { GpoPage } from "./components/GpoPage.tsx";
import { UserDetailPage } from "./components/UserDetailPage.tsx";
import { ComputerDetailPage } from "./components/ComputerDetailPage.tsx";
import { SetupPage } from "./components/SetupPage.tsx";
import { getSetupStatus } from "./lib/domain.ts";
import type { SetupStatus } from "./lib/types.ts";
import { useCockpitLocation } from "./lib/hooks.ts";
import { VERSION } from "./lib/version.ts";

function Header() {
  const { t } = useTranslation();
  return (
    <PageSection>
      <Flex alignItems={{ default: "alignItemsBaseline" }}>
        <FlexItem>
          <Title headingLevel="h1" size="2xl">
            Samba DC
          </Title>
        </FlexItem>
        <FlexItem
          className="pf-v6-u-font-size-sm pf-v6-u-text-color-subtle"
          title={t("Module version")}
        >
          {VERSION}
        </FlexItem>
      </Flex>
    </PageSection>
  );
}

// The setup check first: on a host with no domain (Samba installed, nothing
// provisioned) the tabs give way to the setup page.
export function App() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  async function check() {
    setChecking(true);
    try {
      setStatus(await getSetupStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void check();
  }, []);

  if (status?.provisioned) return <DomainApp />;
  return (
    <Page sidebar={null}>
      <Header />
      {error && (
        <PageSection>
          <Alert variant="danger" isInline title={t("Cannot check this host")}>{error}</Alert>
        </PageSection>
      )}
      {!status && !error && (
        <Bullseye><Spinner size="lg" aria-label={t("Checking this host")} /></Bullseye>
      )}
      {status && (
        <SetupPage status={status} checking={checking} onRecheck={() => void check()}
          onProvisioned={() => void check()} />
      )}
    </Page>
  );
}

function DomainApp() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string | number>("users");
  const location = useCockpitLocation();
  // "/<user>": a user's page; "/computers/<name>": a computer's
  const detailComputer =
    location.path.length === 2 && location.path[0] === "computers" ? location.path[1] : null;
  const detailUsername =
    location.path.length === 1 ? location.path[0] : null;
  const detail = detailUsername ?? (detailComputer !== null ? `computers/${detailComputer}` : null);

  // Lists stay mounted (hidden) while the detail page or another tab is
  // shown; bump a token on the way back so they refetch what may have been
  // edited there, and when an OU changes (renaming or moving one moves what
  // is in it).
  const [listRefreshToken, setListRefreshToken] = useState(0);
  const prevDetailRef = useRef(detail);
  useEffect(() => {
    if (prevDetailRef.current !== null && detail === null) {
      setListRefreshToken((n) => n + 1);
    }
    prevDetailRef.current = detail;
  }, [detail]);

  return (
    <Page sidebar={null}>
      {/* Main layout — always in DOM to preserve UsersPage filter/sort state */}
      <div hidden={detail !== null}>
        <Header />
        <PageSection type="tabs" padding={{ default: "noPadding" }}>
          <Tabs
            activeKey={activeTab}
            onSelect={(_e, key) => {
              setActiveTab(key);
              // A change made in one tab can show in another (a move, an OU
              // renamed): read again, from the cache unless a change dropped it
              setListRefreshToken((n) => n + 1);
            }}
            mountOnEnter
          >
            <Tab eventKey="users" title={<TabTitleText>{t("Users")}</TabTitleText>}>
              <UsersPage refreshToken={listRefreshToken} />
            </Tab>
            <Tab eventKey="groups" title={<TabTitleText>{t("Groups")}</TabTitleText>}>
              <GroupsPage refreshToken={listRefreshToken} />
            </Tab>
            <Tab
              eventKey="shares"
              title={<TabTitleText>{t("Shared folders")}</TabTitleText>}
            >
              <SharesPage />
            </Tab>
            <Tab
              eventKey="computers"
              title={<TabTitleText>{t("Computers")}</TabTitleText>}
            >
              <ComputersPage refreshToken={listRefreshToken} />
            </Tab>
            <Tab
              eventKey="ous"
              title={<TabTitleText>{t("Organizational units")}</TabTitleText>}
            >
              <OusPage
                refreshToken={listRefreshToken}
                onChange={() => setListRefreshToken((n) => n + 1)}
              />
            </Tab>
            <Tab eventKey="dns" title={<TabTitleText>{t("DNS")}</TabTitleText>}>
              <DnsPage />
            </Tab>
            <Tab
              eventKey="gpo"
              title={<TabTitleText>{t("Group Policy")}</TabTitleText>}
            >
              <GpoPage refreshToken={listRefreshToken} />
            </Tab>
            <Tab
              eventKey="domain"
              title={<TabTitleText>{t("Domain")}</TabTitleText>}
            >
              <DomainPage />
            </Tab>
          </Tabs>
        </PageSection>
      </div>

      {detailUsername !== null && <UserDetailPage username={detailUsername} />}
      {detailComputer !== null && <ComputerDetailPage name={detailComputer} />}
    </Page>
  );
}
