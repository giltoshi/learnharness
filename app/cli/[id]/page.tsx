import { notFound } from "next/navigation";
import { CliChat } from "@/components/cli-chat";
import { getCliChat } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function CliChatPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getCliChat(id);
	if (!chat) notFound();
	return <CliChat key={chat.id} chatId={chat.id} title={chat.title} initialMessages={chat.messages} />;
}
