/**
 * How large an op may be. `validateOp` enforces these on everything the API is sent, so a
 * design, its op log and every replica of it stay bounded whatever a client posts.
 */

/** One op as JSON, in UTF-8 bytes. A batch counts whole, children included. */
export const MAX_OP_BYTES = 1024 * 1024;

/** Any one string: a text node, an attribute or CSS value, the tokens, a note, a message. */
export const MAX_STRING_LENGTH = 256 * 1024;

/** A name: a file, page, artboard or layer, an icon, a tag, an attribute, a CSS property. */
export const MAX_NAME_LENGTH = 256;

/** An id, of anything. */
export const MAX_ID_LENGTH = 64;

/** How deep the node trees in one op may nest, counting the top node as 1. */
export const MAX_NODE_DEPTH = 100;

/** Elements and text nodes in one op, across every tree it carries. */
export const MAX_NODES = 10_000;

/** Attributes on one element, and declarations in one style. */
export const MAX_ENTRIES = 1_000;

/** A list that isn't nodes: the ops of a batch, the pages of an order, a thread's messages. */
export const MAX_LIST_LENGTH = 1_000;

/** Batches inside batches: 1 is a batch of plain ops. */
export const MAX_BATCH_DEPTH = 4;
