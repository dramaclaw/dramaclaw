import type { ChatAttachment } from "@/features/superchat/types";
import { uploadApi } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";

/**
 * Files picked in the chat composer.
 *
 * A chat attachment carries an address, never the file bytes. The composer
 * keeps each picked `File` by attachment id until send, then uploads it and
 * sends the address the server returns. Home chat has no project, so its
 * files go to the per-user chat upload route.
 */
export type ComposerFiles = ReadonlyMap<string, File>;

type HomeChatUpload = {
  url: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
};

type HomeChatUploadResponse = { ok: true; data: HomeChatUpload } | { ok: false; error: string };

export type PreparedComposerAttachment = {
  attachment: ChatAttachment;
  original: ChatAttachment;
  error?: string;
};

export function composerFileAttachment(file: File, id: string): ChatAttachment {
  return {
    id,
    type: file.type.startsWith("image/") ? "image" : "file",
    mimeType: file.type || "application/octet-stream",
    fileName: file.name,
    fileSize: file.size,
  };
}

export function composerFileOf(
  attachment: ChatAttachment,
  files: ComposerFiles,
): File | undefined {
  return attachment.id ? files.get(attachment.id) : undefined;
}

export function forgetComposerFiles(files: Map<string, File>, sent: ChatAttachment[]): void {
  for (const attachment of sent) {
    if (attachment.id) files.delete(attachment.id);
  }
}

async function uploadHomeChatFile(file: File): Promise<HomeChatUpload> {
  const body = new FormData();
  body.append("file", file, file.name);
  const response = await jsonWithBackendError<HomeChatUploadResponse>(
    uploadApi.post("api/v1/chat/uploads", { body }),
  );
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export async function uploadHomeAttachments(
  attachments: ChatAttachment[],
  files: ComposerFiles,
): Promise<PreparedComposerAttachment[]> {
  const prepared: PreparedComposerAttachment[] = [];
  for (const attachment of attachments) {
    const file = composerFileOf(attachment, files);
    if (!file) {
      prepared.push({ attachment, original: attachment });
      continue;
    }
    try {
      const upload = await uploadHomeChatFile(file);
      prepared.push({ original: attachment, attachment: { ...attachment, ...upload } });
    } catch (error) {
      prepared.push({
        original: attachment,
        attachment,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return prepared;
}
