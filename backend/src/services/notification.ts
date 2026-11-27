import prisma from "../prisma";

interface SendNotificationParams {
  userId: string;
  type: string;
  channel?: string;
  title: string;
  body: string;
  relatedDoc?: { docType: string; docId: string; docNumber: string };
}

export async function sendNotification(params: SendNotificationParams) {
  return prisma.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      channel: params.channel || "PUSH",
      title: params.title,
      body: params.body,
      relatedDoc: params.relatedDoc ? JSON.stringify(params.relatedDoc) : null,
      sentAt: new Date(),
    },
  });
}

export async function sendNotificationBulk(
  userIds: string[],
  params: Omit<SendNotificationParams, "userId">
) {
  const now = new Date();
  return prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: params.type,
      channel: params.channel || "PUSH",
      title: params.title,
      body: params.body,
      relatedDoc: params.relatedDoc ? JSON.stringify(params.relatedDoc) : null,
      sentAt: now,
    })),
  });
}
