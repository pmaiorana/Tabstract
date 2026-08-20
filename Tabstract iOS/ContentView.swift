import SwiftUI
import UIKit

struct TabstractLogoShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let scale = s / 24.0
        var path = Path()

        let rr = CGRect(x: 3 * scale, y: 3 * scale, width: 18 * scale, height: 18 * scale)
        path.addRoundedRect(in: rr, cornerSize: CGSize(width: 2 * scale, height: 2 * scale))

        path.move(to: CGPoint(x: 9 * scale, y: 15 * scale))
        path.addLine(to: CGPoint(x: 15 * scale, y: 9 * scale))

        return path
    }
}

struct ContentView: View {
    var body: some View {
        ZStack {
            Color.white
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                HStack(spacing: 10) {
                    TabstractLogoShape()
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                        .frame(width: 32, height: 32)

                    Text("Tabstract")
                        .font(.system(size: 28, weight: .light))
                        .foregroundColor(.accentColor)
                }
                .padding(.bottom, 8)

                Text("Save open tabs, and bring them back later.")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 36)

                Button(action: {
                    if let url = URL(string: "https://tabstract.app/ios-install.html") {
                        UIApplication.shared.open(url)
                    }
                }) {
                    Text("Install in Safari")
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: 320)
                        .padding(.vertical, 14)
                        .background(Color.accentColor)
                        .cornerRadius(12)
                }
                .padding(.horizontal, 40)

                Spacer()
            }
        }
    }
}
