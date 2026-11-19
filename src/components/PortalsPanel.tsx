import React from 'react';
import { ExternalLink } from 'lucide-react';
import { PORTAL_LIST } from '../utils/captchaLogic';

export const PortalsPanel: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">Quy tắc nhận diện 4 Cổng Thuế & Dịch vụ công</h2>
          <p className="mt-1 text-xs text-slate-600">
            Mỗi cổng sử dụng selector riêng và đọc ảnh trực tiếp từ DOM (hoặc rasterize SVG) để không làm mất phiên captcha đang mở.
          </p>
        </div>

        <div className="divide-y divide-slate-200">
          {PORTAL_LIST.map((portal) => (
            <div key={portal.id} className="px-6 py-5 grid grid-cols-1 gap-4 lg:grid-cols-12 items-start">
              <div className="lg:col-span-4 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{portal.name}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <a
                    href={`https://${portal.host}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-sky-700 hover:underline"
                  >
                    <span>{portal.host}</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="text-xs text-slate-600">{portal.pathHint}</p>
              </div>

              <div className="lg:col-span-5 space-y-2 text-xs">
                <div>
                  <span className="font-medium text-slate-500">Selector ảnh: </span>
                  <code className="font-mono text-slate-800 break-all">{portal.imgSelector}</code>
                </div>
                <div>
                  <span className="font-medium text-slate-500">Selector ô nhập: </span>
                  <code className="font-mono text-slate-800 break-all">{portal.inputSelector}</code>
                </div>
              </div>

              <div className="lg:col-span-3 text-xs space-y-1">
                <div className="font-medium text-slate-800">
                  {portal.imageMode === 'svg-raster'
                    ? 'SVG mẫu font (<5ms) · Fallback ONNX/Gemini'
                    : 'Canvas DOM → PNG nền trắng (ONNX/Gemini)'}
                </div>
                <p className="text-slate-600 leading-relaxed">{portal.notes}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
