// node_helper.js
const NodeHelper = require('node_helper');
const { GoogleGenAI, Modality } = require('@google/genai');

module.exports = NodeHelper.create({
    start: function () {
        console.log('Starting node helper for: ' + this.name);
        this.session = null;
        this.client = null;
    },

    socketNotificationReceived: async function (notification, payload) {
        if (notification === 'INIT_GEMINI') {
            // The API key is passed securely from the main config.js
            this.client = new GoogleGenAI({ apiKey: payload.apiKey });
            this.initSession();
        } else if (notification === 'SEND_AUDIO_CHUNK') {
            if (this.session) {
                // Forward the raw audio data to the Gemini API
                this.session.sendRealtimeInput({ media: payload });
            }
        } else if (notification === 'RESET_SESSION') {
            if (this.session) {
                this.session.close();
                this.initSession();
            }
        }
    },

    initSession: async function () {
        try {
            this.session = await this.client.live.connect({
                model: 'gemini-2.5-flash-preview-native-audio-dialog',
                callbacks: {
                    onopen: () => {
                        this.sendSocketNotification('STATUS_UPDATE', 'Session opened. Start recording.');
                    },
                    onmessage: (message) => {
                        const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;
                        const interrupted = message.serverContent?.interrupted;

                        if (audio) {
                            // Send the base64 audio data back to the frontend to be played
                            this.sendSocketNotification('AUDIO_RESPONSE', audio.data);
                        }
                        if (interrupted) {
                            this.sendSocketNotification('INTERRUPTED');
                        }
                    },
                    onerror: (e) => {
                        this.sendSocketNotification('ERROR', e.message);
                    },
                    onclose: (e) => {
                        this.sendSocketNotification('STATUS_UPDATE', 'Session closed: ' + e.reason);
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Enceladus' } } },
                },
            });
        } catch (e) {
            console.error(e);
            this.sendSocketNotification('ERROR', e.message);
        }
    }
});