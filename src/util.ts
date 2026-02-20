import { z } from "zod";

export const versionedApiJsonSchema = z.record(z.string(), z.any());
export type VersionedApiJson = z.infer<typeof versionedApiJsonSchema>;

export const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const asciiSchema = z.string().regex(/^[\x20-\x7E]+$/);

export const oldPlaygroupsSchema = z.record(z.string(), z.object({
    name: asciiSchema,
    description: z.string()
}));
export type OldPlaygroups = z.infer<typeof oldPlaygroupsSchema>;

// custom error type which can be given an existing error to preserve the stack trace and append additional information to the message
export class DTSError extends Error {
    constructor(message: string, originalError?: Error) {
        super(`${message}${originalError ? `: ${originalError.message}` : ''}`);
        this.name = 'DTSError';
        if (originalError && originalError.stack) {
            this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
        }
    }
}
