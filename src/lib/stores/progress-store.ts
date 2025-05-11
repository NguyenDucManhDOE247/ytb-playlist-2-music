import { create } from "zustand";

export type ProgressStatus = 
  | "fetching"
  | "downloading" 
  | "completed"
  | "error";

export interface ProgressItem {
  title: string;
  status: ProgressStatus;
  progress: number;
}

interface ProgressState {
  progress: Record<string, ProgressItem>;
  startVideo: (id: string, title: string) => void;
  setStatus: (id: string, status: ProgressStatus) => void;
  setProgress: (id: string, progress: number) => void;
  setNotified: (id: string) => void;
  reset: () => void;
}

export const useProgressStore = create<ProgressState>((set) => ({
  progress: {},
  startVideo: (id, title) =>
    set((state) => ({
      progress: {
        ...state.progress,
        [id]: {
          title,
          status: "fetching",
          progress: 0,
        },
      },
    })),
  setStatus: (id, status) =>
    set((state) => {
      if (!state.progress[id]) return state;
      
      return {
        progress: {
          ...state.progress,
          [id]: {
            ...state.progress[id],
            status,
          },
        },
      };
    }),
  setProgress: (id, progress) =>
    set((state) => {
      if (!state.progress[id]) return state;
      
      return {
        progress: {
          ...state.progress,
          [id]: {
            ...state.progress[id],
            progress,
          },
        },
      };
    }),
  setNotified: (id) =>
    set((state) => {
      if (!state.progress[id]) return state;
      
      return {
        progress: {
          ...state.progress,
          [id]: {
            ...state.progress[id],
            notified: true,
          },
        },
      };
    }),
  reset: () => set({ progress: {} }),
}));
