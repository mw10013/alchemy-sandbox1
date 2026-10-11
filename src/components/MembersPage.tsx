// Adapted from Astryx's table page template.
import { useAtomValue } from "@effect/atom-react";
import { HStack } from "@astryxdesign/core/Stack";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import * as DateTime from "effect/DateTime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Member } from "../api/backend.ts";
import { membersAtom } from "../backend-client.ts";

type Row = Member & Record<string, unknown>;

const columns: TableColumn<Row>[] = [
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
    key: "role",
    header: "Role",
    renderCell: (member) => <Token label={member.role} />,
  },
  {
    key: "createdAt",
    header: "Added",
    renderCell: (member) => (
      <Text type="body" color="secondary">
        {DateTime.formatIsoDateUtc(DateTime.makeUnsafe(member.createdAt * 1000))}
      </Text>
    ),
  },
];

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
                idKey="email"
                hasHover
              />
            ),
            onFailure: () => (
              <Text as="p" role="alert">
                The members could not be loaded.
              </Text>
            ),
          })}
        </LayoutContent>
      }
    />
  );
}
