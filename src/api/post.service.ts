import axios from "axios";

const URL = process.env.CONPLETUS_API as string;

/**
 * Send updated post to backend
 * @param {string} data
 * @param {number} documentId
 * @param {number} languageId
 * @param {string} token
 */
export const updateDocument = async ({ data, documentId, languageId, token }: { data: string, documentId: string, languageId: number, token: string }) => {
    try {
        await axios.patch(
            `${ URL }/v1/document/${documentId}/language/${languageId}`,
            JSON.stringify({ fulltext: data }),
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
            }
        )
    } catch(error: any) {
        // Sentry.captureException(error);
        let message = `Callback request error ${error.message}`
        if (error.code === 'ECONNABORTED') {
            message = 'Callback request timed out.';
            console.warn(message);
        } else {
            console.error(message);
        }

        throw new Error(message);
    }
}
