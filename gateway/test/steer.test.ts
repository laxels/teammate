import { describe, expect, test } from "bun:test";
import { SessionManager } from "../src/session";
import { dispatchSteerMessage, parseSteerClientMessage } from "../src/steer";
import { createEchoQueryFn, createEventRecorder, until } from "./helpers";

describe("parseSteerClientMessage", () => {
  test("rejects non-string frames, invalid JSON and non-objects", () => {
    expect(parseSteerClientMessage(new Uint8Array([1, 2]))).toBeNull();
    expect(parseSteerClientMessage("{nope")).toBeNull();
    expect(parseSteerClientMessage('"just a string"')).toBeNull();
    expect(parseSteerClientMessage("null")).toBeNull();
  });

  test("rejects unknown message types", () => {
    expect(parseSteerClientMessage('{"type":"reboot"}')).toBeNull();
  });

  test("user_message requires non-empty text", () => {
    expect(parseSteerClientMessage('{"type":"user_message"}')).toBeNull();
    expect(
      parseSteerClientMessage('{"type":"user_message","text":42}'),
    ).toBeNull();
    expect(
      parseSteerClientMessage('{"type":"user_message","text":"  "}'),
    ).toBeNull();
    expect(
      parseSteerClientMessage('{"type":"user_message","text":"do it"}'),
    ).toEqual({ type: "user_message", text: "do it" });
  });

  test("interrupt parses", () => {
    expect(parseSteerClientMessage('{"type":"interrupt"}')).toEqual({
      type: "interrupt",
    });
  });

  test("set_permission_mode validates the mode", () => {
    expect(
      parseSteerClientMessage('{"type":"set_permission_mode","mode":"yolo"}'),
    ).toBeNull();
    expect(
      parseSteerClientMessage('{"type":"set_permission_mode","mode":"plan"}'),
    ).toEqual({ type: "set_permission_mode", mode: "plan" });
  });
});

describe("dispatchSteerMessage", () => {
  function makeSession() {
    const { queryFn, control } = createEchoQueryFn();
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({ emitEvent, queryFn });
    return { session, control, events };
  }

  test("invalid frames produce an error reply", async () => {
    const { session } = makeSession();
    expect(await dispatchSteerMessage("garbage", session)).toEqual({
      type: "error",
      message: "invalid steer message",
    });
  });

  test("user_message without a live session produces an error reply", async () => {
    const { session } = makeSession();
    expect(
      await dispatchSteerMessage(
        '{"type":"user_message","text":"hello"}',
        session,
      ),
    ).toEqual({ type: "error", message: "no active session" });
  });

  test("user_message is pushed into the live session", async () => {
    const { session, events } = makeSession();
    session.start({ taskId: "task-1", prompt: "first" });
    await until(() => events.some((e) => e.summary === "done: first"));

    const reply = await dispatchSteerMessage(
      '{"type":"user_message","text":"follow-up"}',
      session,
    );
    expect(reply).toBeNull();
    await until(() => events.some((e) => e.summary === "done: follow-up"));
  });

  test("interrupt stops the live session", async () => {
    const { session, control } = makeSession();
    session.start({ taskId: "task-1", prompt: "first" });

    const reply = await dispatchSteerMessage('{"type":"interrupt"}', session);
    expect(reply).toBeNull();
    expect(control.interrupts).toBe(1);
    await until(() => !session.status().running);
  });

  test("set_permission_mode forwards to the SDK session", async () => {
    const { session, control } = makeSession();
    session.start({ taskId: "task-1", prompt: "first" });

    const reply = await dispatchSteerMessage(
      '{"type":"set_permission_mode","mode":"acceptEdits"}',
      session,
    );
    expect(reply).toBeNull();
    expect(control.permissionModes).toEqual(["acceptEdits"]);
  });
});
