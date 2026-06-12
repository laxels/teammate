import { createContext, useContext } from "react";

export type DashboardConfig = {
  convexUrl: string;
  secret: string;
};

export const ConfigContext = createContext<DashboardConfig | null>(null);

export function useDashboardSecret(): string {
  const config = useContext(ConfigContext);
  if (config === null) {
    throw new Error("ConfigContext missing");
  }
  return config.secret;
}
