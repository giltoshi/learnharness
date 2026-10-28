import { createCliChat, listCliChats } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ chats: listCliChats() });
}

export async function POST() {
	const chat = createCliChat();
	return Response.json({ id: chat.id, title: chat.title });
}
