import { useAtomValue } from "@effect/atom-react";
import { HStack } from "@astryxdesign/core/Stack";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import * as DateTime from "effect/DateTime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Member } from "../api/backend.ts";
import { membersAtom } from "../backend-client.ts";

type Row = Member & Record<string, unknown>;

const columns: TableColumn<Row>[] = [
  {
    key: "shop",
    header: "Shop",
    renderCell: (member) => <Text type="body">{member.shop}</Text>,
  },
  {
    key: "email",
    header: "Email",
    renderCell: (member) => (
      <Text type="body" weight="semibold">
        {member.email}
      </Text>
    ),
  },
  {
    key: "createdAt",
    header: "Added",
    renderCell: (member) => (
      <Text type="body" color="secondary">
        {DateTime.formatIsoDateUtc(DateTime.makeUnsafe(member.createdAt))}
      </Text>
    ),
  },
];

/**
 * Every shop's members: one row per `Member`, so an email in two shops is two rows.
 *
 * Adapted from Astryx's `table-page` page template.
 *
 * @see refs/astryx/packages/cli/assets/templates/pages/table-page/page.tsx
 */
export default function MembersPage() {
  const members = useAtomValue(membersAtom);

  return (
    <Layout
      padding={6}
      header={
        <LayoutHeader hasDivider>
          <HStack vAlign="center" hAlign="between">
            <Text type="large" weight="semibold">
              Members
            </Text>
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {AsyncResult.match(members, {
            onInitial: () => (
              <Text as="p" role="status">
                Loading…
              </Text>
            ),
            onSuccess: ({ value }) => (
              <Table<Row>
                data={value.map((member) => ({ ...member }))}
                columns={columns}
                idKey="id"
                hasHover
              />
            ),
            onFailure: () => (
              <Text as="p" role="alert">
                Couldn't load members.
              </Text>
            ),
          })}
        </LayoutContent>
      }
    />
  );
}
