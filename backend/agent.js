// Backend agent (Vercel AI SDK) that the frontend agent delegates to.
//
// Zero trust towards the client:
//   - the user comes from the session cookie, never from the request body
//   - every tool is scoped to that user, and the policy is re-checked in code
//   - the conversation (including pending approvals) lives server-side, so the
//     client can only answer an elicitation this server issued, for this user
//
// Elicitation: refund_booking has `needsApproval`. When the model calls it, we
// stop and send the client an MCP-style elicitation (message + requestedSchema).
// The user's answer becomes the tool-approval-response and the loop resumes.

import crypto from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { log } from './http.js';
import { OPENAI_MODEL } from './tvm.js';
import { getBooking, listBookings, refundBooking, refundCheck } from './tickets.js';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REFUND_REASONS = ['Can no longer attend', 'Booked the wrong showtime', 'Booked the wrong movie', 'Other'];

const SYSTEM = `You are CineFlow's backend booking agent. You handle questions about the user's existing bookings and refunds.
Use list_my_bookings to find bookings. If several bookings could match, ask which one.
Once you know the booking, call refund_booking immediately. Never ask for confirmation or a refund reason in text:
refund_booking collects both from the user through a secure form.
If the user declines, do not retry. Reply in short plain text without markdown.
Today is ${new Date().toLocaleDateString('en-CA')}.`;

const conversations = new Map(); // id -> { userId, messages, pending, reasons }

function toolsFor(userId, conv) {
  return {
    list_my_bookings: tool({
      description: "Lists the current user's bookings, including whether each one is refundable.",
      inputSchema: z.object({}),
      execute: async () => ({ bookings: listBookings(userId) }),
    }),
    refund_booking: tool({
      description: 'Refunds one of the current user\'s bookings. The user is asked to confirm and give a reason first.',
      inputSchema: z.object({ booking_id: z.string().describe('Booking id, e.g. "BK-1A2B3C".') }),
      // Only elicit when the refund could actually go through; otherwise execute reports why not.
      needsApproval: async ({ booking_id }) => refundCheck(userId, booking_id).ok,
      execute: async ({ booking_id }, { toolCallId }) => refundBooking(userId, booking_id, conv.reasons.get(toolCallId)),
    }),
  };
}

async function step(conversationId) {
  const conv = conversations.get(conversationId);
  const result = await generateText({
    model: openai.chat(OPENAI_MODEL),
    system: SYSTEM,
    messages: conv.messages,
    tools: toolsFor(conv.userId, conv),
    stopWhen: stepCountIs(6),
  });
  conv.messages.push(...result.response.messages);
  log('backend agent', conv.userId, `model=${result.response.modelId}`, `steps=${result.steps.length}`,
    `tools=${result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)).join(',') || '-'}`);

  const approval = result.content.find((p) => p.type === 'tool-approval-request');
  if (approval) {
    const booking = getBooking(conv.userId, approval.toolCall.input.booking_id);
    conv.pending = { approvalId: approval.approvalId, toolCallId: approval.toolCall.toolCallId };
    log('elicitation issued', conv.userId, booking.id);
    return {
      status: 'elicitation',
      conversationId,
      model: result.response.modelId,
      elicitation: {
        id: approval.approvalId,
        message: `Refund ${booking.id}: ${booking.quantity} × ${booking.title}, ${booking.date} at ${booking.time}. You will get $${booking.total} back.`,
        requestedSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', title: 'Reason for refund', enum: REFUND_REASONS },
            confirm: { type: 'boolean', title: 'I understand my tickets will be cancelled' },
          },
          required: ['reason', 'confirm'],
        },
      },
    };
  }
  conv.pending = null;
  return { status: 'done', conversationId, model: result.response.modelId, text: result.text };
}

/** POST /api/agent { task, conversationId? } */
export async function ask(userId, { task, conversationId }) {
  if (typeof task !== 'string' || !task.trim()) throw Object.assign(new Error('task is required'), { status: 400 });
  let conv = conversationId && conversations.get(conversationId);
  if (conv && conv.userId !== userId) conv = undefined; // never resume someone else's conversation
  if (!conv) {
    conversationId = crypto.randomUUID();
    conv = { userId, messages: [], pending: null, reasons: new Map() };
    conversations.set(conversationId, conv);
  }
  if (conv.pending) throw Object.assign(new Error('An elicitation is awaiting a response'), { status: 409 });
  conv.messages.push({ role: 'user', content: task });
  log('delegated task', userId, JSON.stringify(task));
  return step(conversationId);
}

/** POST /api/agent/elicitation { conversationId, elicitationId, action: accept|decline|cancel, content } */
export async function answerElicitation(userId, { conversationId, elicitationId, action, content }) {
  const conv = conversations.get(conversationId);
  if (!conv || conv.userId !== userId || conv.pending?.approvalId !== elicitationId) {
    throw Object.assign(new Error('Unknown elicitation'), { status: 404 });
  }
  const accepted = action === 'accept' && REFUND_REASONS.includes(content?.reason) && content?.confirm === true;
  if (action === 'accept' && !accepted) throw Object.assign(new Error('A reason and confirmation are required'), { status: 400 });

  if (accepted) conv.reasons.set(conv.pending.toolCallId, content.reason);
  conv.messages.push({
    role: 'tool',
    content: [{
      type: 'tool-approval-response',
      approvalId: elicitationId,
      approved: accepted,
      reason: accepted ? content.reason : `User chose to ${action}`,
    }],
  });
  conv.pending = null;
  log('elicitation answered', userId, action, accepted ? content.reason : '');
  return step(conversationId);
}
