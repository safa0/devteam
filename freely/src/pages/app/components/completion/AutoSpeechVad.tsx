import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib/utils";
import { useDeepgramStreaming } from "@/hooks/useDeepgramStreaming";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId?: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const { selectedSttProvider, allSttProviders } = useApp();

  const providerConfig = allSttProviders.find(
    (p) => p.id === selectedSttProvider.provider
  );

  const isDeepgramStreaming =
    providerConfig?.streaming === true &&
    selectedSttProvider.provider === "deepgram-stt" &&
    !!selectedSttProvider.variables.api_key;

  const { sendPcmFrame, finalize, isConnected } = useDeepgramStreaming({
    apiKey: selectedSttProvider.variables.api_key ?? "",
    model: selectedSttProvider.variables.model ?? "nova-2",
    onInterimTranscript: setInterimTranscript,
    onFinalTranscript: (text) => {
      if (text.trim()) submit(text);
      setInterimTranscript("");
      setIsTranscribing(false);
    },
    enabled: isDeepgramStreaming,
  });

  const audioConstraints: MediaTrackConstraints =
    microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: { exact: microphoneDeviceId } }
      : {};

  const vad = useMicVAD({
    userSpeakingThreshold: 0.6,
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    onSpeechStart: () => {
      if (isDeepgramStreaming) setInterimTranscript("");
    },
    onFrameProcessed: (_probabilities, frame) => {
      if (isDeepgramStreaming && isConnected) sendPcmFrame(frame);
    },
    onSpeechEnd: async (audio) => {
      if (isDeepgramStreaming && isConnected) {
        setIsTranscribing(true);
        finalize();
        return;
      }
      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        let transcription: string;

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider || !providerConfig) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Use the fetchSTT function for all providers
        transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        if (transcription) {
          submit(transcription);
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  return (
    <>
      {interimTranscript && (
        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
          {interimTranscript}
        </span>
      )}
      <Button
        size="icon"
        onClick={() => {
          if (vad.listening) {
            vad.pause();
            setEnableVAD(false);
          } else {
            vad.start();
            setEnableVAD(true);
          }
        }}
        className="cursor-pointer"
      >
        {isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4 animate-pulse" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
