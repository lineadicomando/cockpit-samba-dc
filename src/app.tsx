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
} from "@patternfly/react-core";
import { UsersPage } from "./components/UsersPage.tsx";
import { GroupsPage } from "./components/GroupsPage.tsx";
import { ComputersPage } from "./components/ComputersPage.tsx";
import { SharesPage } from "./components/SharesPage.tsx";
import { DomainPage } from "./components/DomainPage.tsx";
import { OusPage } from "./components/OusPage.tsx";
import { UserDetailPage } from "./components/UserDetailPage.tsx";
import { ComputerDetailPage } from "./components/ComputerDetailPage.tsx";
import { useCockpitLocation } from "./lib/hooks.ts";
import { VERSION } from "./lib/version.ts";

export function App() {
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
