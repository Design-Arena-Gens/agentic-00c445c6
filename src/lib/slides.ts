export type SlideAlignment = "center" | "top" | "bottom";

const createSlideId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export type Slide = {
  id: string;
  title: string;
  subtitle: string;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  duration: number;
  imageDataUrl?: string;
  alignment: SlideAlignment;
};

export const defaultSlide = (): Slide => ({
  id: createSlideId(),
  title: "New Scene",
  subtitle: "Tap to edit your message",
  backgroundColor: "#111827",
  textColor: "#f9fafb",
  accentColor: "#f97316",
  duration: 3,
  alignment: "center",
});

export const duplicateSlide = (slide: Slide): Slide => ({
  ...slide,
  id: createSlideId(),
  title: `${slide.title} Copy`,
});
