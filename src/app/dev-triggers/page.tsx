import { notFound } from "next/navigation";
import { TriggerFixture } from "./TriggerFixture";

export default async function DevTriggersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { notice, partial } = await searchParams;
  return <TriggerFixture withNotice={notice !== undefined} partial={partial !== undefined} />;
}
