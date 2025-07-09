/* global Module, Log */

// Define Utility Functions

function encode(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function decode(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

function createBlob(data) {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
        // convert float32 -1 to 1 to int16 -32768 to 32767
        int16[i] = Math.max(-32768, Math.min(32767, data[i] * 32768));
    }

    return {
        data: encode(new Uint8Array(int16.buffer)),
        mimeType: 'audio/pcm;rate=16000',
    };
}

async function decodeAudioData(data, ctx, sampleRate, numChannels) {
    const numSamplesPerChannel = data.length / 2 / numChannels;
    const buffer = ctx.createBuffer(
        numChannels,
        numSamplesPerChannel,
        sampleRate,
    );

    const pcmData = new Int16Array(data.buffer, data.byteOffset, data.length / 2);

    for (let channel = 0; channel < numChannels; channel++) {
        const outputChannel = buffer.getChannelData(channel);
        for (let i = 0; i < numSamplesPerChannel; i++) {
            const sampleIndex = i * numChannels + channel;
            outputChannel[i] = pcmData[sampleIndex] / 32768.0;
        }
    }
    return buffer;
}

// Register the module with MagicMirror

Module.register('MMM-GeminiLiveAudio', {
    defaults: {
        apiKey: '', // IMPORTANT: This must be set in config.js
        model: 'gemini-2.5-flash-preview-native-audio-dialog',
        voice: 'Enceladus',
        defaultBio: 'You are a helpful assistant',
    },

    // --- Module Properties ---
    isRecording: false,
    status: 'Initializing...',
    inputAudioContext: null,
    outputAudioContext: null,
    outputNode: null,
    nextStartTime: 0,
    mediaStream: null,
    sourceNode: null,
    audioWorkletNode: null, // Replaces scriptProcessorNode
    sources: null,
    currentBio: "",

    // --- Core MagicMirror² Methods ---

    start: function () {
        Log.info(`Starting module: ${this.name}`);

        this.sources = new Set();

        if (!this.config.apiKey) {
            this.status = 'Error: API key not set in config.js';
            Log.error(this.status);
            return;
        }

        this.inputAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        this.outputAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        this.outputNode = this.outputAudioContext.createGain();
        this.outputNode.connect(this.outputAudioContext.destination);

        // Start communication with the node_helper
        this.sendSocketNotification('INIT_GEMINI', this.config);
    },

    getStyles: function () {
        return ['MMM-GeminiLiveAudio.css'];
    },

    getDom: function () {
        const wrapper = document.createElement('div');
        wrapper.className = 'gemini-voice-wrapper';

        const statusEl = document.createElement('div');
        statusEl.id = 'status';
        statusEl.className = 'status';
        statusEl.textContent = this.status;
        statusEl.setAttribute('role', 'status');
        statusEl.setAttribute('aria-live', 'polite');

        wrapper.appendChild(statusEl);
        return wrapper;
    },

    notificationReceived: function (notification, payload, sender) {
        if (notification === 'GEMINI_START_RECORDING') {
            this.startRecording();
        } else if (notification === 'GEMINI_STOP_RECORDING') {
            this.stopRecording();
        } else if (notification === 'GEMINI_RESET_SESSION') {
            this.resetSession(payload);
        }
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === 'STATUS_UPDATE') {
            this.status = payload;
            this.updateDom(500);
        } else if (notification === 'ERROR') {
            this.status = `Error: ${payload}`;
            Log.error(this.status);
            this.updateDom(500);
        } else if (notification === 'AUDIO_RESPONSE') {
            this.playAudio(payload);
        } else if (notification === 'INTERRUPTED') {
            for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
            }
            this.nextStartTime = 0;
        }
    },

    // --- Audio Handling Methods ---

    playAudio: async function (base64Data) {
        this.nextStartTime = Math.max(
            this.nextStartTime,
            this.outputAudioContext.currentTime,
        );

        const audioBuffer = await decodeAudioData(
            decode(base64Data),
            this.outputAudioContext,
            24000,
            1,
        );

        const source = this.outputAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.outputNode);
        source.addEventListener('ended', () => {
            this.sources.delete(source);
        });

        source.start(this.nextStartTime);
        this.nextStartTime = this.nextStartTime + audioBuffer.duration;
        this.sources.add(source);
    },

    startRecording: async function () {
        if (this.isRecording) return;

        this.inputAudioContext.resume();
        this.status = 'Requesting microphone...';
        this.updateDom();

        try {
            // Load the audio processor worklet
            try {
                await this.inputAudioContext.audioWorklet.addModule(this.file('audio-processor.js'));
            } catch (e) {
                Log.error(`Failed to load audio worklet: ${e}`);
                this.status = 'Error: Could not load audio processor.';
                this.updateDom();
                return;
            }

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false,
            });

            this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
            this.audioWorkletNode = new AudioWorkletNode(this.inputAudioContext, 'audio-processor');

            // Listen for messages from the worklet
            this.audioWorkletNode.port.onmessage = (event) => {
                if (!this.isRecording) return;
                // event.data contains the Float32Array of PCM data
                this.sendSocketNotification('SEND_AUDIO_CHUNK', createBlob(event.data));
            };

            // Connect the graph
            this.sourceNode.connect(this.audioWorkletNode);
            this.audioWorkletNode.connect(this.inputAudioContext.destination);

            this.isRecording = true;
            this.status = '🔴 Recording... Speak now.';
        } catch (err) {
            Log.error('Error starting recording:', err);
            this.status = `Error: ${err.message}`;
            this.stopRecording();
        } finally {
            this.updateDom();
        }
    },

    stopRecording: function () {
        if (!this.isRecording && !this.mediaStream) return;

        this.isRecording = false;

        if (this.audioWorkletNode) {
            this.audioWorkletNode.port.onmessage = null; // Clean up listener
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }

        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }

        this.status = 'Recording stopped.';
        this.updateDom();
    },

    resetSession: function () {
        if (this.isRecording) {
            this.stopRecording();
        }
        this.status = 'Resetting session...';
        this.updateDom();
        this.sendSocketNotification('RESET_SESSION',);
    },
});