/**
 * The columns a task write nulls to release a claim, in one place so every
 * writer that ends a task clears the same fields. A terminal status write
 * (finish, approve, merge, webhook) clears the work claim and the review claim
 * with their timestamps: a claim left on a finished task is read again as an
 * active claim as soon as the task's workflow stops treating its status as
 * terminal (a workflow switch), and then blocks the holder's next pickup.
 */
export const clearWork = { claimedByUserId: null, claimedByAgentId: null, claimedAt: null } as const;
export const clearReview = { reviewClaimedByUserId: null, reviewClaimedByAgentId: null, reviewClaimedAt: null } as const;
/** Work claim and review claim, as written with a terminal status. */
export const clearAllClaims = { ...clearWork, ...clearReview } as const;
