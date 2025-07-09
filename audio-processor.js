
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An AudioWorkletProcessor to capture raw PCM audio data.
 * It receives audio from the microphone input and posts it back to the main
 * thread for further processing.
 */
class AudioProcessor extends AudioWorkletProcessor {
    /**
     * The process method is called for each block of 128 audio frames.
     * @param {Float32Array[][]} inputs - An array of inputs, each with an array of channels.
     * @param {Float32Array[][]} outputs - An array of outputs.
     * @param {Record<string, Float32Array>} parameters - Audio parameters.
     * @returns {boolean} - Return true to keep the processor alive.
     */
    process(inputs, outputs, parameters) {
        // We only expect one input, and we are only interested in the first channel (mono).
        const input = inputs[0];
        if (input && input.length > 0) {
            const pcmData = input[0];
            // Post the raw audio data (Float32Array) back to the main thread.
            this.port.postMessage(pcmData);
        }

        // Keep the processor running.
        return true;
    }
}

// Register the processor with the name 'audio-processor'.
registerProcessor('audio-processor', AudioProcessor);
