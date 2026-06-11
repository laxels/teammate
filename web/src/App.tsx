import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { VncScreen, type VncScreenHandle } from "react-vnc";
import type { SteerClientMessage } from "../../shared/protocol";
import { Sidebar } from "./Sidebar";
import { SteerClient, steerUrl, vncUrl } from "./steer";
import { initialState, reduce } from "./transcript";

const VNC_RETRY_MS = 3000;

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const clientRef = useRef<SteerClient | null>(null);

  useEffect(() => {
    const client = new SteerClient(steerUrl(window.location), {
      onMessage: (message) => dispatch({ kind: "server", message }),
      onConnectionChange: (connected) =>
        dispatch({ kind: "connection", connected }),
    });
    clientRef.current = client;
    client.start();
    return () => {
      clientRef.current = null;
      client.stop();
    };
  }, []);

  const send = useCallback((message: SteerClientMessage) => {
    clientRef.current?.send(message);
  }, []);

  const sendUserMessage = useCallback(
    (text: string) => {
      send({ type: "user_message", text });
      dispatch({ kind: "local_user", text });
    },
    [send],
  );

  const interrupt = useCallback(() => {
    send({ type: "interrupt" });
  }, [send]);

  return (
    <div className="app">
      <VncPane />
      <Sidebar
        state={state}
        onSendMessage={sendUserMessage}
        onInterrupt={interrupt}
      />
    </div>
  );
}

function VncPane() {
  const ref = useRef<VncScreenHandle>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const url = useMemo(() => vncUrl(window.location), []);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) {
        clearTimeout(retryTimer.current);
      }
    },
    [],
  );

  return (
    <main className="vnc-pane">
      <VncScreen
        ref={ref}
        url={url}
        autoConnect
        scaleViewport
        retryDuration={VNC_RETRY_MS}
        background="#262522"
        style={{ width: "100%", height: "100%" }}
        onDisconnect={(event) => {
          // react-vnc auto-retries unclean disconnects on its own; clean
          // closes (e.g. gateway restart) need a manual reconnect.
          if (event?.detail.clean !== true || retryTimer.current !== null) {
            return;
          }
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            ref.current?.connect();
          }, VNC_RETRY_MS);
        }}
      />
    </main>
  );
}
